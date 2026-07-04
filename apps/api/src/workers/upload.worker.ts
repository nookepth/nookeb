import { Queue, Worker, type Job } from 'bullmq';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer as readAll } from 'node:stream/consumers';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { createWorker as createTesseractWorker } from 'tesseract.js';
import {
  FILE_QUEUE,
  type AddScanPageJob,
  type BatchItem,
  type FileJob,
  type FileRecord,
  type FinalizeScanJob,
  type GenerateThumbnailJob,
  type OcrImageJob,
  type FileScanStatus,
  type PurgeDeletedJob,
  type SpaceRecord,
  type TeamRecord,
  type UploadBatchJob,
  type UploadFileJob,
  type UserRecord,
} from '@nookeb/shared';
import { config } from '../config';
import { createRedis } from '../plugins/redis';
import {
  createR2Client,
  buildFileKey,
  buildScanPageKey,
  buildThumbnailKey,
  deleteObject,
  getObjectStream,
  uploadStream,
  SizeLimitExceededError,
} from '../services/r2.service';
import { getMessageContent, getProfile, pushMessage } from '../services/line.service';
import { buildSummaryFlexMessage } from '../services/flex.service';
import {
  ensureUserAndSpace,
  createFileRecord,
  markFileReady,
  markFileError,
  addStorageUsed,
  checkFileSizeLimit,
  FileRejectedError,
} from '../services/file.service';
import { isVirusScanEnabled, scanBuffer, type ScanVerdict } from '../services/virusTotal.service';
import { ensureGroupSpace } from '../services/space.service';
import {
  getTeamByLineGroup,
  incrementTeamStorage,
  StorageQuotaError,
} from '../services/team.service';
import { purgeDeletedFiles } from '../services/purge.service';
import * as progressStore from '../services/progress-store';
import {
  countPages,
  finishSession,
  getSession,
  insertPage,
  listPages,
  pageExists,
  setSessionStatus,
} from '../services/scan.service';

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const r2 = createR2Client();

// Same queue the API uses — the worker enqueues follow-up jobs (thumbnails) here
const fileQueue = new Queue<FileJob>(FILE_QUEUE, { connection: createRedis() });

const THUMBNAIL_WIDTH = 480;

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : null;
}

function jobId(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^a-zA-Z0-9-_]/g, '-')}`;
}

// GB is declared below with the size-cap helpers; toGb is only called at runtime
const toGb = (bytes: number): string => (bytes / GB).toFixed(2);

function teamFullMessage(team: TeamRecord): string {
  return `พื้นที่ทีมเต็มแล้วน้า (${toGb(team.storage_used)}GB / ${toGb(team.storage_limit)}GB) ติดต่อเจ้าของทีมเพื่อขยายพื้นที่น้า`;
}

/**
 * Team bound to the source LINE group, if any. Best-effort: a lookup failure
 * (e.g. migration 005 not applied yet) falls back to the personal-quota flow
 * rather than failing the upload.
 */
async function resolveTeamForUpload(
  lineSource: string | null,
  lineGroupId: string | null,
): Promise<TeamRecord | null> {
  if (lineSource !== 'group' || !lineGroupId) return null;
  try {
    return await getTeamByLineGroup(supabase, lineGroupId);
  } catch (err) {
    console.error('[upload.worker] team lookup failed — falling back to personal quota:', err);
    return null;
  }
}

/**
 * upload_file job:
 *   download LINE CDN → stream to R2 → files.status = 'ready' → LINE push confirm
 * Never touches local disk — the LINE response body is piped straight to R2.
 */
async function processUploadFile(job: UploadFileJob): Promise<void> {
  // 1. Resolve user + space (LINE Group files go to the group's space — Phase 3;
  //    Phase 1 stores everything in the sender's personal space)
  let profile: { displayName: string; pictureUrl?: string } | undefined;
  try {
    profile = await getProfile(job.lineUserId);
  } catch {
    // profile is optional — continue without it
  }
  const { user, space: personalSpace } = await ensureUserAndSpace(
    supabase,
    job.lineUserId,
    profile?.displayName,
    profile?.pictureUrl,
  );

  // 1b. Files sent in a LINE group land in the group's shared team space
  const space =
    job.lineSource === 'group' && job.lineGroupId
      ? await ensureGroupSpace(supabase, job.lineGroupId, user)
      : personalSpace;

  // 1c. Group bound to a team → the file belongs to the team + team quota
  const team = await resolveTeamForUpload(job.lineSource ?? null, job.lineGroupId ?? null);

  // 2. Quota check (team quota when the group is team-bound)
  if (team) {
    if (team.storage_used >= team.storage_limit) {
      await pushMessage(job.lineUserId, [{ type: 'text', text: teamFullMessage(team) }]);
      return;
    }
  } else if (user.storage_used >= user.storage_limit) {
    await pushMessage(job.lineUserId, [
      { type: 'text', text: 'พื้นที่เก็บไฟล์เต็มแล้วน้า ลบไฟล์เก่าหรืออัปเกรดแผนก่อนหน่อยน้า' },
    ]);
    return;
  }

  // 3. Download from LINE CDN (TTL ~1 ชม. — ต้องรีบทำ)
  const content = await getMessageContent(job.lineMessageId);
  const mimeType = job.mimeType ?? content.contentType;

  // 4. Create DB row first so we have the file id for the R2 key
  const fileId = randomUUID();
  const r2Key = buildFileKey(space.id, fileId, job.originalName);
  const record = await createFileRecord(supabase, {
    id: fileId,
    spaceId: space.id,
    uploadedBy: user.id,
    originalName: job.originalName,
    mimeType,
    fileSize: content.contentLength ?? 0,
    extension: extensionOf(job.originalName),
    r2Key,
    lineMessageId: job.lineMessageId,
    lineSource: job.lineSource,
    lineGroupId: job.lineGroupId,
    teamId: team?.id ?? null,
  });

  // 5. Stream upload to R2
  try {
    const { size } = await uploadStream(r2, r2Key, content.stream, mimeType);
    await markFileReady(supabase, record.id, size);
    // Team-bound files charge the TEAM quota (unenforced post-store — the soft
    // check above already gated); otherwise the uploader's personal quota.
    if (team) {
      await incrementTeamStorage(supabase, team.id, size, { enforce: false });
    } else {
      await addStorageUsed(supabase, user.id, size, space.id);
    }
  } catch (err) {
    await markFileError(supabase, record.id);
    throw err;
  }

  // The file is now durably stored + charged. Everything below is secondary —
  // it must NOT throw, or the whole job would retry and store a *second* copy.

  // 6. Images get a thumbnail + OCR — separate jobs so their failure never fails the upload
  if (mimeType.startsWith('image/')) {
    try {
      await fileQueue.add(
        'generate_thumbnail',
        { type: 'generate_thumbnail', fileId: record.id },
        { jobId: jobId('thumb', record.id), attempts: 3, backoff: { type: 'exponential', delay: 3000 } },
      );
      await fileQueue.add(
        'ocr_image',
        { type: 'ocr_image', fileId: record.id },
        { jobId: jobId('ocr', record.id), attempts: 2, backoff: { type: 'exponential', delay: 5000 } },
      );
    } catch (err) {
      console.error(`[upload.worker] failed to enqueue thumbnail/ocr for ${record.id}:`, err);
    }
  }

  // 7. Confirm to the user (best-effort — a failed push must not re-store the file)
  try {
    await pushMessage(job.lineUserId, [
      { type: 'text', text: `หนูเก็บ "${job.originalName}" ให้แล้วน้า\nเปิดดูได้ที่ ${config.WEB_URL}/dashboard เลยน้า` },
    ]);
  } catch (err) {
    console.error(`[upload.worker] confirm push failed for ${record.id}:`, err);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Retry `fn` up to `attempts` times with exponential backoff (1s → 2s → 4s).
 * FileRejectedError is deterministic (size cap, malware) — rethrown immediately,
 * never retried.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof FileRejectedError) throw err;
      lastErr = err;
      if (i < attempts - 1) await sleep(1000 * 2 ** i);
    }
  }
  throw lastErr;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** User-facing rejection text for a file over the hard size cap. */
function sizeLimitMessage(filename: string, bytes: number | null): string {
  const sizeText = bytes !== null ? `${Math.round(bytes / MB)} MB` : 'ใหญ่';
  const limitGb = (config.MAX_FILE_SIZE_BYTES / GB).toFixed(config.MAX_FILE_SIZE_BYTES % GB === 0 ? 0 : 1);
  return `❌ ไฟล์ "${filename}" มีขนาด ${sizeText} เกินขีดจำกัด ${limitGb} GB\nระบบไม่สามารถรับไฟล์นี้ได้`;
}

/** User-facing alert for a file VirusTotal flagged as malicious. */
function malwareAlertMessage(filename: string, verdict: Extract<ScanVerdict, { outcome: 'malicious' }>): string {
  const shown = verdict.engines.slice(0, 3).join(', ');
  const more = Math.max(0, verdict.detections - Math.min(3, verdict.engines.length));
  const detectedBy = more > 0 ? `${shown} และอีก ${more} รายการ` : shown;
  return (
    `🚨 ระบบตรวจพบไฟล์อันตราย\n` +
    `ไฟล์ "${filename}" ถูกบล็อกโดยอัตโนมัติ\n` +
    `ตรวจพบโดย: ${detectedBy}\n` +
    `ไฟล์นี้ไม่ถูกบันทึกในระบบ`
  );
}

/**
 * Store a single file: size check → LINE CDN → virus scan → R2 → DB row ready →
 * charge quota (which runs the storage-alert check) → enqueue thumbnail/OCR for
 * images. Throws on failure so `withRetry` can retry it; deterministic
 * rejections (size cap, malware) throw FileRejectedError, which is never
 * retried and carries the LINE message for the sender.
 */
async function storeUpload(
  user: UserRecord,
  space: SpaceRecord,
  item: BatchItem,
  lineSource: UploadBatchJob['lineSource'],
  lineGroupId: string | null,
  team: TeamRecord | null = null,
): Promise<{ filename: string; url: string; size: number }> {
  // Open the LINE CDN response — at this point only headers have been read;
  // the body isn't consumed until something pulls from the stream, so a size
  // rejection here aborts before any transfer (and before any DB row exists).
  const content = await getMessageContent(item.lineMessageId);
  const mimeType = content.contentType;

  // [1] Hard per-file size cap. Prefer the size LINE declared in the webhook
  // event, falling back to the CDN Content-Length header.
  const declaredSize = item.fileSize ?? content.contentLength;
  if (declaredSize !== null && !checkFileSizeLimit(declaredSize, item.originalName)) {
    content.stream.destroy();
    console.warn(
      `[upload.worker] size limit rejected: user=${user.id} file="${item.originalName}" ` +
        `size=${declaredSize} limit=${config.MAX_FILE_SIZE_BYTES} at=${new Date().toISOString()}`,
    );
    throw new FileRejectedError(
      `file "${item.originalName}" (${declaredSize} bytes) exceeds size limit`,
      sizeLimitMessage(item.originalName, declaredSize),
    );
  }

  // [1b] Team quota — RESERVE the declared size atomically BEFORE any transfer
  // (increment_team_storage RPC refuses an increment past storage_limit). The
  // actual size is settled after upload; every failure path below releases the
  // reservation so a rejected/failed file never eats team quota.
  let reservedOutstanding = 0;
  const releaseReservation = async (): Promise<void> => {
    if (team && reservedOutstanding > 0) {
      const toRelease = reservedOutstanding;
      reservedOutstanding = 0;
      await incrementTeamStorage(supabase, team.id, -toRelease, { enforce: false }).catch((err) => {
        console.error(`[upload.worker] failed to release team reservation (${team.id}):`, err);
      });
    }
  };
  if (team) {
    try {
      await incrementTeamStorage(supabase, team.id, declaredSize ?? 0);
      reservedOutstanding = declaredSize ?? 0;
    } catch (err) {
      content.stream.destroy();
      if (err instanceof StorageQuotaError) {
        console.warn(
          `[upload.worker] team quota rejected: team=${team.id} file="${item.originalName}" size=${declaredSize}`,
        );
        throw new FileRejectedError(
          `team ${team.id} quota exceeded for "${item.originalName}"`,
          teamFullMessage(team),
        );
      }
      throw err;
    }
  }

  // [2] Virus scan — small files only (VT free tier caps uploads at 32 MB).
  // Failures never block the upload; only a confirmed malicious verdict does.
  let scanStatus: FileScanStatus | null = null;
  let bodyStream: Readable = content.stream;
  const fileId = randomUUID();
  const r2Key = buildFileKey(space.id, fileId, item.originalName);
  let record: FileRecord;
  try {
    if (isVirusScanEnabled()) {
      if (content.contentLength !== null && content.contentLength <= config.VIRUSTOTAL_MAX_SCAN_SIZE_BYTES) {
        const buffer = await readAll(content.stream);
        const verdict = await scanBuffer(buffer, item.originalName);
        if (verdict.outcome === 'malicious') {
          console.error(
            `[upload.worker] malicious file blocked: user=${user.id} file="${item.originalName}" ` +
              `detections=${verdict.detections} engines=[${verdict.engines.join(', ')}] at=${new Date().toISOString()}`,
          );
          throw new FileRejectedError(
            `file "${item.originalName}" flagged malicious by ${verdict.detections} engine(s)`,
            malwareAlertMessage(item.originalName, verdict),
          );
        }
        if (verdict.outcome === 'scan_failed') {
          console.warn(`[upload.worker] virus scan failed for "${item.originalName}" — proceeding: ${verdict.reason}`);
          scanStatus = 'scan_failed';
        } else {
          scanStatus = 'clean';
        }
        bodyStream = Readable.from(buffer);
      } else {
        // >32 MB, or size unknown so we can't buffer it safely within the VT cap
        scanStatus = 'skipped_size';
      }
    }

    record = await createFileRecord(supabase, {
      id: fileId,
      spaceId: space.id,
      uploadedBy: user.id,
      originalName: item.originalName,
      mimeType,
      fileSize: content.contentLength ?? 0,
      extension: extensionOf(item.originalName),
      r2Key,
      lineMessageId: item.lineMessageId,
      lineSource,
      lineGroupId,
      scanStatus,
      teamId: team?.id ?? null,
    });
  } catch (err) {
    await releaseReservation();
    throw err;
  }

  try {
    // [3] Stream to R2 with a hard abort at the cap — covers uploads whose real
    // size wasn't known up front (no Content-Length) or was under-declared.
    const { size } = await uploadStream(r2, r2Key, bodyStream, mimeType, config.MAX_FILE_SIZE_BYTES);
    await markFileReady(supabase, record.id, size);
    // [4] Charge quota. Team-bound uploads consume TEAM quota: the declared
    // size was reserved up front, so only the declared-vs-actual drift is
    // settled here (unenforced — the file is already stored). The uploader's
    // personal quota is NOT touched for team files. Personal / unbound-group
    // uploads keep the per-user accounting + storage-alert check.
    if (team) {
      const drift = size - reservedOutstanding;
      reservedOutstanding = 0;
      if (drift !== 0) {
        await incrementTeamStorage(supabase, team.id, drift, { enforce: false }).catch((err) => {
          console.error(`[upload.worker] team storage settle failed (${team.id}):`, err);
        });
      }
    } else {
      await addStorageUsed(supabase, user.id, size, space.id);
    }

    if (mimeType.startsWith('image/')) {
      try {
        await fileQueue.add(
          'generate_thumbnail',
          { type: 'generate_thumbnail', fileId: record.id },
          { jobId: jobId('thumb', record.id), attempts: 3, backoff: { type: 'exponential', delay: 3000 } },
        );
        await fileQueue.add(
          'ocr_image',
          { type: 'ocr_image', fileId: record.id },
          { jobId: jobId('ocr', record.id), attempts: 2, backoff: { type: 'exponential', delay: 5000 } },
        );
      } catch (err) {
        console.error(`[upload.worker] failed to enqueue thumbnail/ocr for ${record.id}:`, err);
      }
    }
    return { filename: item.originalName, url: `${config.WEB_URL}/dashboard`, size };
  } catch (err) {
    await releaseReservation();
    if (err instanceof SizeLimitExceededError) {
      // The stream blew past the cap mid-transfer (size wasn't known up front).
      // uploadStream already aborted the download and deleted the partial R2
      // object; remove the never-ready row too — rejected files must not leave
      // a files row. (Hard delete is safe here: nothing was stored in R2, so
      // the soft-delete/tombstone rule for purge tracking doesn't apply.)
      const { error: delErr } = await supabase.from('files').delete().eq('id', record.id);
      if (delErr) {
        console.error(`[upload.worker] failed to remove rejected file row ${record.id}:`, delErr);
      }
      console.warn(
        `[upload.worker] size limit rejected mid-stream: user=${user.id} file="${item.originalName}" ` +
          `limit=${config.MAX_FILE_SIZE_BYTES} at=${new Date().toISOString()}`,
      );
      throw new FileRejectedError(
        `file "${item.originalName}" exceeded size limit mid-stream`,
        sizeLimitMessage(item.originalName, null),
      );
    }
    await markFileError(supabase, record.id).catch((markErr) => {
      console.error(`[upload.worker] failed to mark file ${record.id} as error:`, markErr);
    });
    throw err;
  }
}

/**
 * upload_batch job: process a debounced batch sequentially. Each file gets up to
 * 3 attempts; a file that still fails is counted and the batch continues. The
 * handler NEVER throws (a batch retry would re-store everything) and always ends
 * with ONE summary Flex push — to the group when in a group, else the user.
 */
async function processUploadBatch(job: UploadBatchJob): Promise<void> {
  const target = job.lineGroupId ?? job.lineUserId;
  // Progress store updates are best-effort — this handler must never throw
  await progressStore.init(job.batchId, job.items.length).catch((err) => {
    console.error('[upload.worker] progress init failed:', err);
  });
  try {
    let profile: { displayName: string; pictureUrl?: string } | undefined;
    try {
      profile = await getProfile(job.lineUserId);
    } catch {
      // optional
    }
    const username = job.username ?? profile?.displayName ?? null;

    const { user, space: personalSpace } = await ensureUserAndSpace(
      supabase,
      job.lineUserId,
      profile?.displayName,
      profile?.pictureUrl,
    );
    const space =
      job.lineSource === 'group' && job.lineGroupId
        ? await ensureGroupSpace(supabase, job.lineGroupId, user)
        : personalSpace;

    // Group bound to a team → files belong to the team and consume TEAM quota
    const team = await resolveTeamForUpload(job.lineSource, job.lineGroupId);

    // Quota gate. Files are now processed in PARALLEL (see below), so instead of
    // threading a running total through a sequential loop we check the
    // batch-start snapshot. The authoritative accounting (increment_storage_used
    // / increment_team_storage RPC) is still atomic and per-file; only the
    // intra-batch soft cutoff is relaxed — a batch may overshoot by at most its
    // own item count. (Team uploads additionally reserve quota per file inside
    // storeUpload, so a team can never actually exceed its limit.)
    const limit = team ? team.storage_limit : user.storage_limit;
    const usedAtStart = team ? team.storage_used : user.storage_used;
    const overLimit = usedAtStart >= limit;
    if (overLimit && team) {
      try {
        await pushMessage(target, [{ type: 'text', text: teamFullMessage(team) }]);
      } catch (err) {
        console.error('[upload.worker] team-full notice push failed:', err);
      }
    }

    // Process the batch in PARALLEL: the dominant cost per file is the VirusTotal
    // poll (up to ~60s). Run sequentially this made a batch stall at 0/N for
    // minutes; overlapping the scans makes the batch finish in ~one scan's time.
    // progressStore.increment is an atomic Redis HINCRBY, so concurrent ticks are
    // safe, and each storeUpload still charges storage atomically on its own.
    const results = await Promise.all(
      job.items.map(async (item): Promise<{ filename: string; url: string } | null> => {
        if (overLimit) return null;
        try {
          const res = await withRetry(
            () => storeUpload(user, space, item, job.lineSource, job.lineGroupId, team),
            3,
          );
          await progressStore.increment(job.batchId).catch(() => undefined);
          return { filename: res.filename, url: res.url };
        } catch (err) {
          if (err instanceof FileRejectedError) {
            // Deterministic rejection (size cap / malware) — withRetry threw it
            // straight through, so this runs exactly once per rejected file.
            console.warn(`[upload.worker] batch item rejected (${item.lineMessageId}): ${err.message}`);
            try {
              await pushMessage(target, [{ type: 'text', text: err.userMessage }]);
            } catch (pushErr) {
              console.error(`[upload.worker] rejection notice push failed (${item.lineMessageId}):`, pushErr);
            }
          } else {
            console.error(`[upload.worker] batch item failed (${item.lineMessageId}):`, err);
          }
          return null;
        }
      }),
    );

    const files = results.filter((r): r is { filename: string; url: string } => r !== null);
    const failed = job.items.length - files.length;

    // In a GROUP chat keep it quiet — one short text line, no Flex card (the card
    // is chatty and noisy in a shared group). 1-on-1 chats keep the full summary.
    try {
      if (job.lineSource === 'group') {
        let text: string;
        if (files.length === 0) {
          text = 'ยังเก็บไม่สำเร็จน้า ลองส่งใหม่อีกทีนะคะ';
        } else if (failed > 0) {
          text = `บันทึกแล้วน้า ✓ (สำเร็จ ${files.length}, พลาด ${failed})`;
        } else {
          text = 'บันทึกแล้วน้า ✓';
        }
        await pushMessage(target, [{ type: 'text', text }]);
      } else {
        const summary = buildSummaryFlexMessage({
          success: files.length,
          failed,
          files,
          dashboardUrl: `${config.WEB_URL}/dashboard`,
          username,
        });
        await pushMessage(target, [summary]);
      }
    } catch (err) {
      console.error('[upload.worker] summary push failed:', err);
    }
  } catch (err) {
    // Setup failed (profile/space resolution) — report a full-failure card, don't throw
    console.error('[upload.worker] upload_batch fatal:', err);
    try {
      if (job.lineSource === 'group') {
        await pushMessage(target, [
          { type: 'text', text: 'ยังเก็บไม่สำเร็จน้า ลองส่งใหม่อีกทีนะคะ' },
        ]);
      } else {
        await pushMessage(target, [
          buildSummaryFlexMessage({
            success: 0,
            failed: job.items.length,
            files: [],
            dashboardUrl: `${config.WEB_URL}/dashboard`,
            username: job.username,
          }),
        ]);
      }
    } catch {
      /* ignore — nothing else we can do */
    }
  } finally {
    await progressStore.complete(job.batchId).catch(() => undefined);
  }
}

/**
 * generate_thumbnail job:
 *   stream original from R2 → sharp resize → stream thumb.webp back to R2 →
 *   files.thumbnail_key. Streaming end-to-end — no local disk.
 */
async function processGenerateThumbnail(job: GenerateThumbnailJob): Promise<void> {
  const { data, error } = await supabase
    .from('files')
    .select('*')
    .eq('id', job.fileId)
    .maybeSingle();
  if (error) throw error;
  const file = data as FileRecord | null;
  if (!file || file.deleted_at || file.status !== 'ready') return;
  if (!file.mime_type.startsWith('image/')) return;

  const source = await getObjectStream(r2, file.r2_key);
  const resizer = sharp()
    .rotate() // respect EXIF orientation
    .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
    .webp({ quality: 78 });

  const thumbnailKey = buildThumbnailKey(file.space_id, file.id);
  await uploadStream(r2, thumbnailKey, source.pipe(resizer), 'image/webp');

  const { error: updateErr } = await supabase
    .from('files')
    .update({ thumbnail_key: thumbnailKey, updated_at: new Date().toISOString() })
    .eq('id', file.id);
  if (updateErr) throw updateErr;
}

/**
 * ocr_image job: OCR an uploaded image (Thai + English) → files.ocr_text.
 * Best-effort — failure here never affects the stored file.
 */
async function processOcrImage(job: OcrImageJob): Promise<void> {
  const { data, error } = await supabase.from('files').select('*').eq('id', job.fileId).maybeSingle();
  if (error) throw error;
  const file = data as FileRecord | null;
  if (!file || file.deleted_at || file.status !== 'ready') return;
  if (!file.mime_type.startsWith('image/')) return;

  const original = await readAll(await getObjectStream(r2, file.r2_key));
  // Grayscale + bounded size makes OCR faster and more accurate
  const prepared = await sharp(original)
    .rotate()
    .resize({ width: 2000, withoutEnlargement: true })
    .grayscale()
    .png()
    .toBuffer();

  const worker = await getTesseract();
  const { data: result } = await worker.recognize(prepared);
  const text = result.text.replace(/\s+/g, ' ').trim();

  const { error: updateErr } = await supabase
    .from('files')
    .update({ ocr_text: text.length > 0 ? text : null, updated_at: new Date().toISOString() })
    .eq('id', file.id);
  if (updateErr) throw updateErr;
}

/**
 * add_scan_page job: download the page from LINE → normalize to JPEG →
 * store in R2 scan-temp → insert scan_page row.
 */
async function processAddScanPage(job: AddScanPageJob): Promise<void> {
  const session = await getSession(supabase, job.sessionId);
  if (!session || session.status !== 'collecting' || !session.space_id) return;

  // Retry-safe: if a previous attempt already stored this message, don't add it twice
  if (await pageExists(supabase, session.id, job.lineMessageId)) return;

  const content = await getMessageContent(job.lineMessageId);
  const jpeg = await sharp(await readAll(content.stream))
    .rotate()
    .resize({ width: 1600, withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();

  const pageId = randomUUID();
  const key = buildScanPageKey(session.space_id, session.id, pageId);
  await uploadStream(r2, key, Readable.from(jpeg), 'image/jpeg');

  const pageNumber = (await countPages(supabase, session.id)) + 1;
  await insertPage(supabase, session.id, pageNumber, key, job.lineMessageId);
}

/**
 * finalize_scan job: merge all scan pages into one PDF → store as a file →
 * confirm to the user. Temp page objects are cleaned up afterwards.
 */
async function processFinalizeScan(job: FinalizeScanJob): Promise<void> {
  const session = await getSession(supabase, job.sessionId);
  if (!session || !session.space_id) return;
  // Retry-safe: the webhook flips the session to 'processing' before enqueuing.
  // If a prior attempt already finished it ('done'), don't build a second PDF.
  if (session.status !== 'processing') return;

  const pages = await listPages(supabase, session.id);
  if (pages.length === 0) {
    await setSessionStatus(supabase, session.id, 'cancelled');
    await pushMessage(job.lineUserId, [{ type: 'text', text: 'ยังไม่มีไฟล์ให้รวมเป็น PDF เลยน้า' }]);
    return;
  }

  const pdf = await PDFDocument.create();
  for (const page of pages) {
    const jpeg = await sharp(await readAll(await getObjectStream(r2, page.r2_key)))
      .rotate()
      .jpeg({ quality: 82 })
      .toBuffer();
    const img = await pdf.embedJpg(jpeg);
    const pdfPage = pdf.addPage([img.width, img.height]);
    pdfPage.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  const pdfBytes = await pdf.save();

  // Team-bound group scans charge the TEAM quota (like normal group uploads),
  // not the uploader's personal quota. The scan session's space is the group's
  // shared space; its line_group_id tells us which LINE group this came from.
  let team: TeamRecord | null = null;
  const { data: spaceRow } = await supabase
    .from('spaces')
    .select('line_group_id')
    .eq('id', session.space_id)
    .maybeSingle();
  const lineGroupId = (spaceRow as { line_group_id: string | null } | null)?.line_group_id ?? null;
  if (lineGroupId) {
    team = await getTeamByLineGroup(supabase, lineGroupId).catch((err) => {
      console.error('[upload.worker] finalize_scan team lookup failed — personal quota:', err);
      return null;
    });
  }

  // Reserve the team quota BEFORE storing so an over-quota team never stores the
  // PDF. The merged size is known exactly (pdfBytes.length), so there's no drift.
  if (team) {
    try {
      await incrementTeamStorage(supabase, team.id, pdfBytes.length);
    } catch (err) {
      if (err instanceof StorageQuotaError) {
        await setSessionStatus(supabase, session.id, 'cancelled');
        await pushMessage(job.lineUserId, [
          { type: 'text', text: 'พื้นที่ทีมเต็มแล้วน้า ไม่สามารถบันทึกไฟล์รวมรูปได้' },
        ]);
        return;
      }
      throw err;
    }
  }

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const name = `รวมรูป_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.pdf`;

  const fileId = randomUUID();
  const r2Key = buildFileKey(session.space_id, fileId, name);
  const record = await createFileRecord(supabase, {
    id: fileId,
    spaceId: session.space_id,
    uploadedBy: session.user_id,
    originalName: name,
    mimeType: 'application/pdf',
    fileSize: pdfBytes.length,
    extension: 'pdf',
    r2Key,
    lineMessageId: null,
    lineSource: null,
    lineGroupId: null,
    teamId: team?.id ?? null,
  });

  try {
    const { size } = await uploadStream(r2, r2Key, Readable.from(Buffer.from(pdfBytes)), 'application/pdf');
    await markFileReady(supabase, record.id, size);
    if (team) {
      // Settle any (normally zero) difference from the reserved size; never
      // charge the uploader's personal quota for a team file.
      const drift = size - pdfBytes.length;
      if (drift !== 0) {
        await incrementTeamStorage(supabase, team.id, drift, { enforce: false }).catch((err) => {
          console.error(`[upload.worker] finalize_scan team settle failed (${team!.id}):`, err);
        });
      }
    } else {
      await addStorageUsed(supabase, session.user_id, size, session.space_id);
    }
  } catch (err) {
    // Release the team reservation so a failed store (which will retry) never
    // leaks team quota. Personal accounting happens after a successful upload,
    // so it needs no release here.
    if (team) {
      await incrementTeamStorage(supabase, team.id, -pdfBytes.length, { enforce: false }).catch(() => undefined);
    }
    throw err;
  }
  await finishSession(supabase, session.id, record.id, pages.length);

  // Clean up temporary page images (best-effort)
  for (const page of pages) {
    try {
      await deleteObject(r2, page.r2_key);
    } catch {
      /* ignore */
    }
  }

  // Best-effort — the PDF is already stored; a failed push must not rebuild it.
  // Same Flex builder as the upload summary card, in its "merge" variant.
  try {
    await pushMessage(job.lineUserId, [
      buildSummaryFlexMessage({
        success: pages.length,
        failed: 0,
        files: [{ filename: name, url: `${config.WEB_URL}/dashboard` }],
        dashboardUrl: `${config.WEB_URL}/dashboard`,
        username: null,
        merge: { count: pages.length },
      }),
    ]);
  } catch (err) {
    console.error(`[upload.worker] finalize_scan confirm push failed for ${session.id}:`, err);
  }
}

/**
 * purge_deleted job (repeatable, daily): remove R2 objects of files soft-deleted
 * past the retention window. DB rows are kept as tombstones.
 */
async function processPurgeDeleted(_job: PurgeDeletedJob): Promise<void> {
  const result = await purgeDeletedFiles(supabase, r2, {
    retentionDays: config.PURGE_RETENTION_DAYS,
    apply: true,
  });
  console.log(
    `[upload.worker] purge: scanned ${result.scanned} file(s) deleted before ${result.cutoff}, ` +
      `removed ${result.objectsDeleted} R2 object(s), errors ${result.errors}`,
  );
}

/** Register the daily purge as a BullMQ repeatable job (idempotent by repeat key). */
export async function scheduleRepeatableJobs(): Promise<void> {
  await fileQueue.add(
    'purge_deleted',
    { type: 'purge_deleted' },
    { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: 'purge-daily' },
  );
}

let tesseractPromise: Promise<Awaited<ReturnType<typeof createTesseractWorker>>> | null = null;
async function getTesseract() {
  if (!tesseractPromise) tesseractPromise = createTesseractWorker('tha+eng');
  return tesseractPromise;
}

export async function closeWorkerQueue(): Promise<void> {
  await fileQueue.close();
  await progressStore.closeProgressStore();
  if (tesseractPromise) {
    const worker = await tesseractPromise;
    await worker.terminate();
  }
}

export function createUploadWorker(): Worker<FileJob> {
  const worker = new Worker<FileJob>(
    FILE_QUEUE,
    async (job: Job<FileJob>) => {
      switch (job.data.type) {
        case 'upload_file':
          await processUploadFile(job.data);
          break;
        case 'upload_batch':
          await processUploadBatch(job.data);
          break;
        case 'generate_thumbnail':
          await processGenerateThumbnail(job.data);
          break;
        case 'ocr_image':
          await processOcrImage(job.data);
          break;
        case 'add_scan_page':
          await processAddScanPage(job.data);
          break;
        case 'finalize_scan':
          await processFinalizeScan(job.data);
          break;
        case 'purge_deleted':
          await processPurgeDeleted(job.data);
          break;
        default:
          throw new Error(`Unknown job type: ${(job.data as { type: string }).type}`);
      }
    },
    {
      connection: createRedis(),
      concurrency: 5,
    },
  );

  worker.on('completed', (job) => {
    console.log(`[upload.worker] job ${job.id} completed`);
  });
  worker.on('failed', (job, err) => {
    console.error(`[upload.worker] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
