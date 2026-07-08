import { Queue, Worker, type Job } from 'bullmq';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer as readAll } from 'node:stream/consumers';
import sharp from 'sharp';
import {
  FILE_QUEUE,
  sanitizeJobId,
  type AddScanPageJob,
  type BatchItem,
  type ConvertToDocxJob,
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
import {
  ensureUserAndSpace,
  createFileRecord,
  findLiveFileByLineMessageId,
  markFileReady,
  markFileError,
  checkFileSizeLimit,
  incrementPersonalStorage,
  FileRejectedError,
} from '../services/file.service';
import { checkStorageAlert } from '../services/storage-monitor.service';
import { isVirusScanEnabled, scanBuffer, type ScanVerdict } from '../services/virusTotal.service';
import { ensureGroupSpace, getMemberRole } from '../services/space.service';
import {
  getTeamByLineGroup,
  incrementTeamStorage,
  StorageQuotaError,
} from '../services/team.service';
import { purgeDeletedFiles, purgeOrphanScanTemp } from '../services/purge.service';
import * as progressStore from '../services/progress-store';
import {
  countPages,
  deleteScanTempObjects,
  finishSession,
  getSession,
  insertPage,
  listPages,
  pageExists,
  setSessionResultFile,
  setSessionStatus,
} from '../services/scan.service';
import { processScanPage, plainNormalize, buildScanPdf, MSG_PDF_FAILED } from '../services/scan-enhance.service';
import { extractText, terminateOcr } from '../services/ocr.service';
import { isMistralOcrConfigured, mistralOcr, MistralOcrRejectedError } from '../services/mistral-ocr.service';
import { buildDocxFromMarkdown } from '../services/docx-builder.service';
import { buildDocxResultFlexMessage } from '../services/flex.service';

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const r2 = createR2Client();

// Same queue the API uses — the worker enqueues follow-up jobs (thumbnails) here
const fileQueue = new Queue<FileJob>(FILE_QUEUE, { connection: createRedis() });

const THUMBNAIL_WIDTH = 480;

// finalize_scan wait-gate (migration 023). Max times finalize_scan re-enqueues itself
// waiting for in-flight add_scan_page jobs to land before it gives up and builds the PDF
// from whatever pages exist (~MAX * 3s worst-case wait). Hard stop = no infinite loop.
const MAX_FINALIZE_WAITS = 5;
// Pushed when finalize_scan exhausts the wait budget with pages still missing.
const MSG_SCAN_PAGES_INCOMPLETE = 'พบว่าบางหน้าอาจไม่ครบ กรุณาตรวจสอบ PDF ที่ได้รับ';
// Pushed when an add_scan_page job lands after the session already left 'collecting'
// (user typed "เสร็จ" and finalize started) — the page couldn't join the PDF.
const MSG_SCAN_PAGE_TOO_LATE =
  'หน้านี้ส่งมาช้าไปน้า หนูปิดการสแกนรอบนี้ไปแล้ว ถ้าอยากได้หน้านี้ด้วยต้องเริ่มสแกนใหม่น้า';

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : null;
}

// GB is declared below with the size-cap helpers; toGb is only called at runtime
const toGb = (bytes: number): string => (bytes / GB).toFixed(2);

function teamFullMessage(team: TeamRecord): string {
  return `พื้นที่ทีมเต็มแล้วน้า (${toGb(team.storage_used)}GB / ${toGb(team.storage_limit)}GB) ติดต่อเจ้าของทีมเพื่อขยายพื้นที่น้า`;
}

// Same copy the legacy upload_file path used — now also sent when a per-file
// personal-quota reservation is refused (FIX #2).
const PERSONAL_FULL_TEXT =
  'พื้นที่เก็บไฟล์เต็มแล้วน้า ลบไฟล์เก่าหรืออัปเกรดแผนก่อนหน่อยน้า';

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
  uploadedBy: string | null = user.id,
): Promise<{ filename: string; url: string; size: number }> {
  // [0] Idempotency fast-path (migration 022): a batch retry (worker restart /
  // stalled job) or a LINE webhook redelivery can re-run this for a message we
  // already stored. If a live file row already exists for this LINE message id,
  // return it WITHOUT re-downloading from the CDN or charging quota again. The
  // unique partial index is the true guard (the createFileRecord backstop below);
  // this pre-check just avoids the CDN fetch + reservation churn in the common case.
  if (item.lineMessageId) {
    const existing = await findLiveFileByLineMessageId(supabase, item.lineMessageId);
    if (existing) {
      console.log(
        `[upload.worker] dedup: file already stored for message ${item.lineMessageId} ` +
          `(file ${existing.id}) — skipping re-store/charge`,
      );
      return { filename: existing.original_name, url: `${config.WEB_URL}/dashboard`, size: existing.file_size };
    }
  }

  // Open the LINE CDN response — at this point only headers have been read;
  // the body isn't consumed until something pulls from the stream, so a size
  // rejection here aborts before any transfer (and before any DB row exists).
  const content = await getMessageContent(item.lineMessageId);
  const mimeType = content.contentType;

  // [1] Hard per-file size cap. Prefer the size LINE declared in the webhook
  // event, falling back to the CDN Content-Length header.
  const declaredSize = item.fileSize ?? content.contentLength;
  if (declaredSize !== null && !checkFileSizeLimit(declaredSize)) {
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

  // [1b] Quota — RESERVE the declared size atomically BEFORE any transfer, on
  // whichever ledger owns this upload: the TEAM (increment_team_storage RPC,
  // migration 005) or the uploader's PERSONAL quota (increment_personal_storage
  // RPC, migration 014 — FIX #2: the old batch-level snapshot let a user
  // overshoot their limit by an entire batch). The actual size is settled after
  // upload; every failure path below releases the reservation so a
  // rejected/failed file never eats quota.
  let reservedOutstanding = 0;
  const releaseReservation = async (): Promise<void> => {
    if (reservedOutstanding > 0) {
      const toRelease = reservedOutstanding;
      reservedOutstanding = 0;
      if (team) {
        await incrementTeamStorage(supabase, team.id, -toRelease, { enforce: false }).catch((err) => {
          console.error(`[upload.worker] failed to release team reservation (${team.id}):`, err);
        });
      } else {
        await incrementPersonalStorage(supabase, user.id, -toRelease, { enforce: false }).catch((err) => {
          console.error(`[upload.worker] failed to release personal reservation (${user.id}):`, err);
        });
      }
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
  } else {
    let reservation;
    try {
      reservation = await incrementPersonalStorage(supabase, user.id, declaredSize ?? 0, {
        enforce: true,
      });
    } catch (err) {
      content.stream.destroy();
      throw err;
    }
    if (reservation.overLimit) {
      content.stream.destroy();
      console.warn(
        `[upload.worker] personal quota rejected: user=${user.id} file="${item.originalName}" ` +
          `size=${declaredSize} used=${reservation.used} limit=${reservation.limit}`,
      );
      throw new FileRejectedError(
        `user ${user.id} quota exceeded for "${item.originalName}"`,
        PERSONAL_FULL_TEXT,
      );
    }
    reservedOutstanding = declaredSize ?? 0;
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

    const created = await createFileRecord(supabase, {
      id: fileId,
      spaceId: space.id,
      uploadedBy,
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
      // Ledger record (FIX #3): immutable, unlike team_id which deleteTeam
      // nulls — delete refunds follow this, never the uploader's personal quota
      // for a team-charged file.
      chargedTo: team ? 'team' : 'personal',
      chargedTeamId: team?.id ?? null,
    });
    if (created.deduped) {
      // Lost the INSERT race to a concurrent run (unique line_message_id index,
      // migration 022) — that run owns the stored file + its quota charge. Release
      // our reservation and return its row instead of re-storing/charging.
      content.stream.destroy();
      await releaseReservation();
      console.log(
        `[upload.worker] dedup: lost INSERT race for message ${item.lineMessageId} ` +
          `(file ${created.record.id}) — released reservation, skipping re-store/charge`,
      );
      return {
        filename: created.record.original_name,
        url: `${config.WEB_URL}/dashboard`,
        size: created.record.file_size,
      };
    }
    record = created.record;
  } catch (err) {
    await releaseReservation();
    throw err;
  }

  try {
    // [3] Stream to R2 with a hard abort at the cap — covers uploads whose real
    // size wasn't known up front (no Content-Length) or was under-declared.
    const { size } = await uploadStream(r2, r2Key, bodyStream, mimeType, config.MAX_FILE_SIZE_BYTES);
    await markFileReady(supabase, record.id, size);
    // [4] Settle quota. The declared size was reserved up front on the owning
    // ledger (team or personal), so only the declared-vs-actual drift is
    // settled here (unenforced — the file is already stored). The uploader's
    // personal quota is NOT touched for team files. Personal uploads keep the
    // storage-alert check that addStorageUsed used to run.
    if (team) {
      const drift = size - reservedOutstanding;
      reservedOutstanding = 0;
      if (drift !== 0) {
        await incrementTeamStorage(supabase, team.id, drift, { enforce: false }).catch((err) => {
          console.error(`[upload.worker] team storage settle failed (${team.id}):`, err);
        });
      }
    } else {
      const drift = size - reservedOutstanding;
      reservedOutstanding = 0;
      if (drift !== 0) {
        await incrementPersonalStorage(supabase, user.id, drift, { enforce: false }).catch((err) => {
          console.error(`[upload.worker] personal storage settle failed (${user.id}):`, err);
        });
      }
      // 80%/95% owner alerts (+ re-arm) — never throws.
      await checkStorageAlert(supabase, user.id, space.id);
    }

    if (mimeType.startsWith('image/')) {
      try {
        await fileQueue.add(
          'generate_thumbnail',
          { type: 'generate_thumbnail', fileId: record.id },
          { jobId: sanitizeJobId('thumb', record.id), attempts: 3, backoff: { type: 'exponential', delay: 3000 } },
        );
        await fileQueue.add(
          'ocr_image',
          { type: 'ocr_image', fileId: record.id },
          { jobId: sanitizeJobId('ocr', record.id), attempts: 2, backoff: { type: 'exponential', delay: 5000 } },
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

    // Attribute the upload. ensureGroupSpace grants a space_members row to a
    // LINE sender only if they're an active team member (see the invariant
    // there). A sender who is NOT a space member (ex-member still in the group)
    // still has their file stored — but with a NULL uploader, so they gain no
    // dashboard ownership. NULL uploaded_by is the codebase convention for
    // unowned rows (see files.ts DELETE), and team-charged deletes refund the
    // team ledger, not a personal quota that was never charged.
    const uploadedBy =
      space.type === 'team' && (await getMemberRole(supabase, space.id, user.id)) === null
        ? null
        : user.id;

    // Quota gate. Both ledgers now enforce atomically PER FILE inside
    // storeUpload (team: increment_team_storage; personal:
    // increment_personal_storage, migration 014 — FIX #2), so the old personal
    // batch-start snapshot is gone: it allowed overshooting by an entire batch.
    // The team snapshot is kept only as a fast-path that skips the batch with a
    // single notice instead of rejecting every file individually.
    const overLimit = team
      ? team.storage_used >= team.storage_limit
      : user.storage_used >= user.storage_limit;
    if (overLimit && team) {
      try {
        await pushMessage(target, [{ type: 'text', text: teamFullMessage(team) }]);
      } catch (err) {
        console.error('[upload.worker] team-full notice push failed:', err);
      }
    } else if (overLimit && !team) {
      // Personal quota fast-path mirror of the team branch: tell the uploader
      // their personal storage is full (same copy the per-file rejection uses)
      // once, up front, instead of silently counting "failed N". The shared
      // `if (overLimit) return null` below skips storing every file in the batch.
      try {
        await pushMessage(target, [{ type: 'text', text: PERSONAL_FULL_TEXT }]);
      } catch (err) {
        console.error('[upload.worker] personal-full notice push failed:', err);
      }
    }

    // One notice per distinct rejection message per batch: without this, a
    // batch of N over-quota files would push the same storage-full text N
    // times. Size-cap messages embed the filename, so those stay per-file.
    const notifiedRejections = new Set<string>();

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
            () => storeUpload(user, space, item, job.lineSource, job.lineGroupId, team, uploadedBy),
            3,
          );
          await progressStore.increment(job.batchId).catch(() => undefined);
          return { filename: res.filename, url: res.url };
        } catch (err) {
          if (err instanceof FileRejectedError) {
            // Deterministic rejection (size cap / malware / quota) — withRetry
            // threw it straight through, so this runs exactly once per rejected
            // file. The has/add pair runs synchronously (no await between), so
            // parallel items can't both claim the first notice.
            console.warn(`[upload.worker] batch item rejected (${item.lineMessageId}): ${err.message}`);
            if (!notifiedRejections.has(err.userMessage)) {
              notifiedRejections.add(err.userMessage);
              try {
                await pushMessage(target, [{ type: 'text', text: err.userMessage }]);
              } catch (pushErr) {
                console.error(`[upload.worker] rejection notice push failed (${item.lineMessageId}):`, pushErr);
              }
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

    // No completion PUSH here anymore. The user already got the "รอสักครู่น้า …"
    // progress card as a REPLY when the batch was enqueued (upload-queue flush),
    // and its "ดูล็อคเกอร์" button opens the live progress page, which flips to
    // "เสร็จแล้ว" + redirects to the locker as this batch finishes (progressStore
    // .complete in the finally). So the outcome is delivered for free — we only
    // log it here. (Per-file rejection / quota-full notices above are separate:
    // they're rare error events with no reply token, kept as best-effort pushes.)
    console.log(
      `[upload.worker] batch ${job.batchId} done for ${username ?? '[profile unavailable]'}: ` +
        `stored ${files.length}, failed ${failed}`,
    );
  } catch (err) {
    // Setup failed (profile/space resolution). Nothing to reply to (no fresh
    // token in the worker) — the progress card already told the user we're on it,
    // and progressStore.complete below ends the progress page. Log and move on;
    // do NOT push (project goal: reply-only, no paid pushes).
    console.error('[upload.worker] upload_batch fatal:', err);
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

  // Shared OCR engine (ocr.service): Document AI when configured, else the
  // singleton tesseract worker. extractText never throws — '' on failure.
  const text = (await extractText(prepared)).replace(/\s+/g, ' ').trim();

  const { error: updateErr } = await supabase
    .from('files')
    .update({ ocr_text: text.length > 0 ? text : null, updated_at: new Date().toISOString() })
    .eq('id', file.id);
  if (updateErr) throw updateErr;
}

/**
 * add_scan_page job: download the page from LINE → per-kind processing →
 * store in R2 scan-temp → insert scan_page row.
 *   kind 'scan'  (สแกน)   → scan-enhance pipeline (edge detect → perspective
 *                           warp → bw/color enhancement; never throws, falls
 *                           back to the plain normalize per page).
 *   kind 'merge' (รวมรูป) → plain normalize ONLY — merge combines the images
 *                           as-is; running the document pipeline here would
 *                           grayscale/flatten the user's photos.
 * Quality warnings are pushed best-effort AFTER the page is stored, so a push
 * failure can never retry-and-duplicate the page.
 */
async function processAddScanPage(job: AddScanPageJob): Promise<void> {
  const session = await getSession(supabase, job.sessionId);
  if (!session || !session.space_id) return;
  if (session.status !== 'collecting') {
    // The session already left 'collecting'. Previously we returned SILENTLY and the
    // page vanished from the PDF with zero trace. If the user typed "เสร็จ" and
    // finalize is running ('processing'), tell them this page arrived too late — but
    // only when the message isn't already stored (a plain retry of an on-time page
    // must stay quiet). done/cancelled sessions just log-and-drop.
    if (session.status === 'processing') {
      const alreadyStored = await pageExists(supabase, session.id, job.lineMessageId);
      console.warn(
        `[upload.worker] add_scan_page LATE session=${session.id} msg=${job.lineMessageId} ` +
          `status=processing alreadyStored=${alreadyStored} — page arrived after finalize started`,
      );
      if (!alreadyStored && job.lineUserId) {
        try {
          await pushMessage(job.lineUserId, [{ type: 'text', text: MSG_SCAN_PAGE_TOO_LATE }]);
        } catch (err) {
          console.error(`[upload.worker] late-page push failed (${session.id}):`, err);
        }
      }
    }
    return;
  }

  // Retry-safe: if a previous attempt already stored this message, don't add it twice
  if (await pageExists(supabase, session.id, job.lineMessageId)) return;

  const content = await getMessageContent(job.lineMessageId);
  const original = await readAll(content.stream);

  // kind falls back to 'merge' (migration 020's default) and scan_mode to the
  // config default (migration 019) if either migration isn't applied yet.
  const kind = session.session_kind ?? 'merge';
  const mode = session.scan_mode ?? config.SCAN_DEFAULT_MODE;
  let jpeg: Buffer;
  let warnings: string[] = [];
  if (kind === 'scan' && config.SCAN_ENHANCE_ENABLED) {
    const result = await processScanPage(
      original,
      mode,
      `session=${session.id} msg=${job.lineMessageId}`,
    );
    jpeg = result.jpeg;
    warnings = result.warnings;
    // One line per page stating which pipeline path ran — 'skipped' here means
    // the pipeline crashed and degraded to the plain image (see scan-enhance).
    console.log(
      `[upload.worker] add_scan_page session=${session.id} kind=${kind} mode=${mode} ` +
        `edge=${result.edgeDetection} warnings=${warnings.length}`,
    );
  } else {
    // A SCAN page falling through here means the kill switch is on — the user
    // asked for document processing and is getting a raw photo. Say so loudly:
    // this exact state previously shipped unprocessed "สแกน_*.pdf" files with
    // zero log evidence.
    if (kind === 'scan') {
      console.warn(
        `[upload.worker] add_scan_page session=${session.id} SCAN page stored WITHOUT enhancement ` +
          `(SCAN_ENHANCE_ENABLED=false kill switch)`,
      );
    }
    jpeg = await plainNormalize(original);
  }

  const pageId = randomUUID();
  const key = buildScanPageKey(session.space_id, session.id, pageId);
  await uploadStream(r2, key, Readable.from(jpeg), 'image/jpeg');

  await insertPage(supabase, session.id, key, job.lineMessageId);

  // Best-effort retake hints (dark / blurry / edges not found) — the page IS
  // stored either way; a failed push must never fail (and retry) the job.
  if (warnings.length > 0 && job.lineUserId) {
    try {
      await pushMessage(job.lineUserId, [{ type: 'text', text: warnings.join('\n') }]);
    } catch (err) {
      console.error(`[upload.worker] scan warning push failed (${session.id}):`, err);
    }
  }
}

/**
 * finalize_scan job: merge all scan pages into one PDF → store as a file →
 * confirm to the user. Temp page objects are cleaned up afterwards.
 */
async function processFinalizeScan(job: FinalizeScanJob, isLastAttempt: boolean): Promise<void> {
  const t0 = Date.now();
  const log = (stage: string, extra = ''): void =>
    console.log(`[finalize_scan] session=${job.sessionId} stage=${stage} +${Date.now() - t0}ms ${extra}`.trim());
  log('start', `lastAttempt=${isLastAttempt}`);

  const session = await getSession(supabase, job.sessionId);
  if (!session || !session.space_id) return;
  // Retry-safe: the webhook flips the session to 'processing' before enqueuing.
  // If a prior attempt already finished it ('done'), don't build a second PDF.
  if (session.status !== 'processing') return;

  // Retry-safe: if a prior attempt already stored + charged the PDF but crashed
  // before (or during) the finishSession status flip, result_file_id is already
  // recorded. Don't rebuild/re-store/re-charge — just complete the status flip.
  if (session.result_file_id) {
    const pageCount = await countPages(supabase, session.id);
    await finishSession(supabase, session.id, session.result_file_id, pageCount);
    return;
  }

  // Wait-gate (migration 023): "เสร็จ" flips status to 'processing' and enqueues this
  // immediately, but add_scan_page jobs for pages accepted just before "เสร็จ" may still
  // be queued or in CDN-retry backoff. If fewer pages are stored than the webhook
  // accepted (expected_pages), re-enqueue ourselves with a short delay until they land —
  // up to MAX_FINALIZE_WAITS, then build the PDF from what we have and warn the user.
  // expected=0 (migration not applied / no images) makes this a no-op, so it's safe.
  const expected = session.expected_pages ?? 0;
  const stored = await countPages(supabase, session.id);
  if (expected > stored) {
    const waitAttempt = job.waitAttempt ?? 0;
    if (waitAttempt < MAX_FINALIZE_WAITS) {
      log('wait-pages', `stored=${stored} expected=${expected} attempt=${waitAttempt + 1}/${MAX_FINALIZE_WAITS}`);
      await fileQueue.add(
        'finalize_scan',
        { ...job, waitAttempt: waitAttempt + 1 },
        {
          // Distinct jobId per wait so BullMQ doesn't reject it as a duplicate of the
          // just-completed job. Fresh attempts:3 for the real processing that follows.
          jobId: sanitizeJobId(`scan-final-w${waitAttempt + 1}`, session.id),
          delay: 3000,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      );
      return;
    }
    // Wait budget exhausted — an add_scan_page job never landed. Build the PDF from the
    // pages we DO have (better than blocking forever) but tell the user to check it.
    console.warn(
      `[upload.worker] finalize_scan session=${session.id} proceeding with ${stored}/${expected} ` +
        `pages after ${MAX_FINALIZE_WAITS} waits — some pages missing`,
    );
    try {
      await pushMessage(job.lineUserId, [{ type: 'text', text: MSG_SCAN_PAGES_INCOMPLETE }]);
    } catch (err) {
      console.error(`[upload.worker] finalize_scan incomplete-warning push failed (${session.id}):`, err);
    }
  }

  const pages = await listPages(supabase, session.id);
  if (pages.length === 0) {
    await setSessionStatus(supabase, session.id, 'cancelled');
    await pushMessage(job.lineUserId, [{ type: 'text', text: 'ยังไม่มีไฟล์ให้รวมเป็น PDF เลยน้า' }]);
    return;
  }
  log('pages-listed', `count=${pages.length}`);

  // Assemble the PDF (buildScanPdf in scan-enhance.service): one A4 page per
  // scan page (pages are already enhanced + normalized JPEGs from
  // add_scan_page). With SCAN_OCR_ENABLED an invisible OCR text layer makes
  // the PDF searchable — OCR failure inside buildScanPdf is best-effort and
  // never throws. Failure here (unreadable page image / R2 read) is retried by
  // BullMQ like any other throw; on the LAST attempt we cancel the session and
  // tell the user instead of crashing silently — the retake message asks them
  // to run รวมรูป again.
  let pdfBytes: Uint8Array;
  try {
    const jpegs: Buffer[] = [];
    for (const page of pages) {
      jpegs.push(await readAll(await getObjectStream(r2, page.r2_key)));
    }
    pdfBytes = await buildScanPdf(jpegs, {
      ocrEnabled: config.SCAN_OCR_ENABLED,
      logTag: `session=${session.id}`,
    });
    log('pdf-built', `bytes=${pdfBytes.length} ocr=${config.SCAN_OCR_ENABLED}`);
  } catch (err) {
    console.error(`[upload.worker] finalize_scan PDF assembly failed (${session.id}):`, err);
    if (!isLastAttempt) throw err; // let BullMQ retry transient R2 read failures
    await setSessionStatus(supabase, session.id, 'cancelled');
    // The merged PDF will never be produced — free the temp page images now so
    // this permanently-cancelled session doesn't leak them (best-effort).
    await deleteScanTempObjects(supabase, session.id);
    try {
      await pushMessage(job.lineUserId, [{ type: 'text', text: MSG_PDF_FAILED }]);
    } catch (pushErr) {
      console.error(`[upload.worker] finalize_scan failure push failed (${session.id}):`, pushErr);
    }
    return;
  }

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

  // Reserve quota BEFORE storing so an over-quota space never stores the PDF.
  // The merged size is known exactly (pdfBytes.length), so there's no drift.
  // Personal and team paths now both use reserve-before-store: the team branch
  // reserves via incrementTeamStorage (enforce default), the personal branch via
  // incrementPersonalStorage(enforce:true) — mirroring the per-file guard the
  // normal upload path applies. Both release/settle after the store below.
  if (team) {
    try {
      await incrementTeamStorage(supabase, team.id, pdfBytes.length);
    } catch (err) {
      if (err instanceof StorageQuotaError) {
        await setSessionStatus(supabase, session.id, 'cancelled');
        // Same leak class as the assembly-failure path: the session is now
        // permanently cancelled, so free its temp page images (best-effort).
        await deleteScanTempObjects(supabase, session.id);
        await pushMessage(job.lineUserId, [
          { type: 'text', text: 'พื้นที่ทีมเต็มแล้วน้า ไม่สามารถบันทึกไฟล์รวมรูปได้' },
        ]);
        return;
      }
      throw err;
    }
  } else {
    const reservation = await incrementPersonalStorage(supabase, session.user_id, pdfBytes.length, {
      enforce: true,
    });
    if (reservation.overLimit) {
      console.warn(
        `[upload.worker] finalize_scan personal quota rejected: user=${session.user_id} ` +
          `session=${session.id} size=${pdfBytes.length} used=${reservation.used} limit=${reservation.limit}`,
      );
      await setSessionStatus(supabase, session.id, 'cancelled');
      // Same leak class as the assembly-failure path: the session is now
      // permanently cancelled, so free its temp page images (best-effort).
      await deleteScanTempObjects(supabase, session.id);
      await pushMessage(job.lineUserId, [{ type: 'text', text: PERSONAL_FULL_TEXT }]);
      return;
    }
  }

  // Scan sessions name the PDF "สแกน_…"; merge sessions "รวมรูป_…" (migration 020).
  const kind = session.session_kind ?? 'merge';
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const prefix = kind === 'scan' ? 'สแกน' : 'รวมรูป';
  const name = `${prefix}_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.pdf`;

  const fileId = randomUUID();
  const r2Key = buildFileKey(session.space_id, fileId, name);
  // lineMessageId is null for merged scan PDFs, so createFileRecord never dedups
  // here — the result_file_id guard above already makes finalize_scan retry-safe.
  const { record } = await createFileRecord(supabase, {
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
    chargedTo: team ? 'team' : 'personal',
    chargedTeamId: team?.id ?? null,
  });

  try {
    const { size } = await uploadStream(r2, r2Key, Readable.from(Buffer.from(pdfBytes)), 'application/pdf');
    await markFileReady(supabase, record.id, size);
    // Settle any (normally zero) difference from the reserved size. Both paths
    // reserved pdfBytes.length above, so only the drift is applied here (enforce
    // off — a small over-actual must never be refused after the file is stored).
    const drift = size - pdfBytes.length;
    if (team) {
      // Never charge the uploader's personal quota for a team file.
      if (drift !== 0) {
        await incrementTeamStorage(supabase, team.id, drift, { enforce: false }).catch((err) => {
          console.error(`[upload.worker] finalize_scan team settle failed (${team!.id}):`, err);
        });
      }
    } else {
      if (drift !== 0) {
        await incrementPersonalStorage(supabase, session.user_id, drift, { enforce: false }).catch(
          (err) => {
            console.error(`[upload.worker] finalize_scan personal settle failed (${session.user_id}):`, err);
          },
        );
      }
      // Run the storage-usage alert monitor for the space (adjustStorageUsed does
      // this automatically; the enforced-RPC path above does not). Runs after every
      // successful store, not just when there's drift — PDF size is known exactly so
      // drift is almost always 0, and the alert must still fire at 80%/95%.
      await checkStorageAlert(supabase, session.user_id, session.space_id).catch(() => undefined);
    }
  } catch (err) {
    // Release the reservation so a failed store (which will retry) never leaks
    // quota. Both paths reserved pdfBytes.length before storing.
    if (team) {
      await incrementTeamStorage(supabase, team.id, -pdfBytes.length, { enforce: false }).catch(() => undefined);
    } else {
      await incrementPersonalStorage(supabase, session.user_id, -pdfBytes.length, {
        enforce: false,
      }).catch(() => undefined);
    }
    throw err;
  }

  // The PDF is now stored + charged. Record the result id BEFORE the retry
  // boundary (finishSession's status flip) so that if finishSession fails and
  // BullMQ retries, the recovery check above skips a second store/charge.
  await setSessionResultFile(supabase, session.id, record.id);
  log('stored', `fileId=${record.id} team=${team?.id ?? 'none'}`);

  await finishSession(supabase, session.id, record.id, pages.length);
  log('done');

  // Clean up temporary page images (best-effort)
  for (const page of pages) {
    try {
      await deleteObject(r2, page.r2_key);
    } catch {
      /* ignore */
    }
  }

  // No completion PUSH here anymore. When the user typed "เสร็จ", the webhook
  // already REPLIED the finalize-in-progress card (buildFinalizingFlexMessage)
  // with a "ดูล็อคเกอร์" button — fresh reply token, free. The merged PDF is now
  // in the locker, so tapping that button shows it. (Error paths above — empty
  // session / PDF-assembly failure / team-full — keep their best-effort text
  // pushes: they're rare and have no reply token to fall back on.)
  log('done-no-push', `kind=${kind} file=${name}`);
}

// ---------------------------------------------------------------------------
// convert_to_docx — image/PDF → OCR (Mistral, markdown) → editable .docx
// ---------------------------------------------------------------------------

const MSG_DOCX_TOO_LARGE = `ไฟล์ใหญ่เกิน ${Math.round(config.DOCX_CONVERT_MAX_SOURCE_BYTES / (1024 * 1024))}MB น้า ระบบแปลงไฟล์รับได้แค่นี้ก่อน ลองย่อไฟล์หรือแบ่งส่งน้า`;
const MSG_DOCX_UNSUPPORTED = 'หนูแปลงได้เฉพาะรูป (JPG / PNG / WebP) กับไฟล์ PDF น้า';
const MSG_DOCX_UNREADABLE =
  'หนูอ่านข้อความในไฟล์นี้ไม่ออกเลยน้า ลองส่งรูปที่ชัดขึ้น ถ่ายตรงๆ ไม่เอียง แล้วลองใหม่อีกทีน้า';
const MSG_DOCX_FAILED = 'แปลงไฟล์เป็น Word ไม่สำเร็จน้า ขอโทษนะคะ ลองส่งใหม่อีกทีน้า';
const MSG_DOCX_LOW_TEXT = 'ข้อความบางส่วนอาจอ่านไม่ครบ ลองเปิดตรวจก่อนใช้น้า';

// Pages that OCR to fewer than this many characters on average trigger the
// "check the result" warning row (Mistral returns no confidence score, so a
// text-density heuristic is the honest stand-in).
const DOCX_LOW_TEXT_CHARS_PER_PAGE = 80;

/** Magic-byte sniff, falling back to the CDN-declared type. */
function detectConvertMime(buf: Buffer, declared: string): string | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length >= 4 && buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  const base = (declared.split(';')[0] ?? '').trim().toLowerCase();
  return ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(base) ? base : null;
}

function docxOutputName(originalName: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  const dot = originalName.lastIndexOf('.');
  const base = (dot > 0 ? originalName.slice(0, dot) : originalName).trim();
  return `${base || `เวิร์ด_${stamp}`}.docx`;
}

/**
 * convert_to_docx (BullMQ attempts: 3 — LINE CDN content survives retries for
 * ~1h). Retry safety: the output row carries line_message_id `docx-<msgId>`;
 * a 'ready' row under that marker short-circuits the retry, and a failed store
 * soft-deletes its row so the unique live index (migration 022) lets the retry
 * re-insert. User-visible failures push ONE friendly Thai message and return
 * without throwing (no point retrying a too-large / unreadable source).
 */
async function processConvertToDocx(job: ConvertToDocxJob, isLastAttempt: boolean): Promise<void> {
  const markerId = `docx-${job.lineMessageId}`;
  const dashboardUrl = `${config.WEB_URL}/dashboard`;

  // Retry recovery: a previous attempt already stored the .docx.
  const existing = await findLiveFileByLineMessageId(supabase, markerId);
  if (existing) {
    if (existing.status === 'ready') {
      // Stored + charged; only the result push may have been missed — resend it
      // (worst case the user sees the card twice).
      await pushMessage(job.lineUserId, [
        buildDocxResultFlexMessage({ fileName: existing.original_name, pageCount: 1, dashboardUrl }),
      ]).catch(() => undefined);
    }
    return;
  }

  const { user, space } = await ensureUserAndSpace(supabase, job.lineUserId);

  // Download the source from LINE CDN, capped. Buffering is fine here: the cap
  // is DOCX_CONVERT_MAX_SOURCE_BYTES (default 10 MB), not the 1 GB upload cap.
  const cap = config.DOCX_CONVERT_MAX_SOURCE_BYTES;
  const content = await getMessageContent(job.lineMessageId);
  if (content.contentLength !== null && content.contentLength > cap) {
    content.stream.destroy();
    await pushMessage(job.lineUserId, [{ type: 'text', text: MSG_DOCX_TOO_LARGE }]).catch(() => undefined);
    return;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of content.stream) {
    total += (chunk as Buffer).length;
    if (total > cap) {
      content.stream.destroy();
      await pushMessage(job.lineUserId, [{ type: 'text', text: MSG_DOCX_TOO_LARGE }]).catch(() => undefined);
      return;
    }
    chunks.push(chunk as Buffer);
  }
  const source = Buffer.concat(chunks);

  const mime = detectConvertMime(source, content.contentType);
  if (!mime) {
    await pushMessage(job.lineUserId, [{ type: 'text', text: MSG_DOCX_UNSUPPORTED }]).catch(() => undefined);
    return;
  }

  // OCR → per-page markdown. Mistral handles PDFs (digital AND scanned)
  // natively. Fallback when Mistral is unconfigured (webhook normally gates
  // the command on it): plain-text OCR for images; PDFs can't be converted.
  let pagesMarkdown: string[];
  let pageCount: number;
  try {
    if (isMistralOcrConfigured()) {
      const result = await mistralOcr(source, mime);
      pagesMarkdown = result.pages.map((p) => p.markdown);
      pageCount = result.pageCount;
      console.log(
        `[convert_to_docx] msg=${job.lineMessageId} mistral pages=${pageCount} model=${config.MISTRAL_OCR_MODEL}`,
      );
    } else if (mime !== 'application/pdf') {
      pagesMarkdown = [await extractText(source)];
      pageCount = 1;
    } else {
      await pushMessage(job.lineUserId, [{ type: 'text', text: MSG_DOCX_FAILED }]).catch(() => undefined);
      return;
    }
  } catch (err) {
    if (err instanceof MistralOcrRejectedError) {
      // The document itself was refused — retrying the same bytes can't help.
      console.warn(`[convert_to_docx] msg=${job.lineMessageId} rejected:`, err.message);
      await pushMessage(job.lineUserId, [{ type: 'text', text: MSG_DOCX_UNSUPPORTED }]).catch(() => undefined);
      return;
    }
    if (!isLastAttempt) throw err; // transient (timeout / 5xx / 429) — retry
    console.error(`[convert_to_docx] msg=${job.lineMessageId} OCR exhausted:`, err);
    await pushMessage(job.lineUserId, [{ type: 'text', text: MSG_DOCX_FAILED }]).catch(() => undefined);
    return;
  }

  const totalChars = pagesMarkdown.join('').replace(/\s+/g, '').length;
  if (totalChars < 10) {
    await pushMessage(job.lineUserId, [{ type: 'text', text: MSG_DOCX_UNREADABLE }]).catch(() => undefined);
    return;
  }
  const lowText = totalChars / Math.max(pagesMarkdown.length, 1) < DOCX_LOW_TEXT_CHARS_PER_PAGE;

  const docxBuf = await buildDocxFromMarkdown(pagesMarkdown);
  const name = docxOutputName(job.originalName);

  // Reserve quota before storing (same pattern as finalize_scan's personal path;
  // convert is personal-chat only, so there is no team branch).
  const reservation = await incrementPersonalStorage(supabase, user.id, docxBuf.length, { enforce: true });
  if (reservation.overLimit) {
    await pushMessage(job.lineUserId, [{ type: 'text', text: PERSONAL_FULL_TEXT }]).catch(() => undefined);
    return;
  }

  const fileId = randomUUID();
  const r2Key = buildFileKey(space.id, fileId, name);
  const { record, deduped } = await createFileRecord(supabase, {
    id: fileId,
    spaceId: space.id,
    uploadedBy: user.id,
    originalName: name,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    fileSize: docxBuf.length,
    extension: 'docx',
    r2Key,
    lineMessageId: markerId, // dedup marker — a concurrent retry recovers this row
    lineSource: null,
    lineGroupId: null,
    chargedTo: 'personal',
  });
  if (deduped) {
    // A concurrent attempt won the insert race and owns the store + charge.
    await incrementPersonalStorage(supabase, user.id, -docxBuf.length, { enforce: false }).catch(() => undefined);
    return;
  }

  try {
    const { size } = await uploadStream(
      r2,
      r2Key,
      Readable.from(docxBuf),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    await markFileReady(supabase, record.id, size);
    const drift = size - docxBuf.length;
    if (drift !== 0) {
      await incrementPersonalStorage(supabase, user.id, drift, { enforce: false }).catch(() => undefined);
    }
    await checkStorageAlert(supabase, user.id, space.id).catch(() => undefined);
  } catch (err) {
    // Release the reservation and soft-delete the 'processing' row so the
    // marker dedup (live rows only) lets the NEXT attempt re-insert cleanly.
    await incrementPersonalStorage(supabase, user.id, -docxBuf.length, { enforce: false }).catch(() => undefined);
    await supabase
      .from('files')
      .update({ status: 'error', deleted_at: new Date().toISOString() })
      .eq('id', record.id)
      .then(undefined, () => undefined);
    if (!isLastAttempt) throw err;
    console.error(`[convert_to_docx] msg=${job.lineMessageId} store exhausted:`, err);
    await pushMessage(job.lineUserId, [{ type: 'text', text: MSG_DOCX_FAILED }]).catch(() => undefined);
    return;
  }

  // Stored + charged — the job is done; the result card is best-effort.
  await pushMessage(job.lineUserId, [
    buildDocxResultFlexMessage({
      fileName: name,
      pageCount: pagesMarkdown.length,
      dashboardUrl,
      warning: lowText ? MSG_DOCX_LOW_TEXT : undefined,
    }),
  ]).catch((err) => {
    console.error(`[convert_to_docx] result push failed (msg=${job.lineMessageId}):`, err);
  });
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

  // Safety net for orphaned scan-temp page images from cancelled/timed-out sessions.
  const scanSweep = await purgeOrphanScanTemp(supabase);
  console.log(
    `[upload.worker] purge: scan-temp reaped ${scanSweep.expiredReaped} expired session(s), ` +
      `swept ${scanSweep.sessionsSwept} session(s), removed ${scanSweep.objectsDeleted} R2 object(s), ` +
      `errors ${scanSweep.errors}`,
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

export async function closeWorkerQueue(): Promise<void> {
  await fileQueue.close();
  await progressStore.closeProgressStore();
  await terminateOcr();
}

export function createUploadWorker(): Worker<FileJob> {
  const worker = new Worker<FileJob>(
    FILE_QUEUE,
    async (job: Job<FileJob>) => {
      switch (job.data.type) {
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
        case 'finalize_scan': {
          // Capture the narrowed job data in a local — TS drops the discriminant
          // narrowing on `job.data` (a re-evaluated property access) across the
          // awaits/catch below.
          const data = job.data;
          // attemptsMade counts finished attempts; this run is attemptsMade + 1
          const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
          try {
            await processFinalizeScan(data, isLastAttempt);
          } catch (err) {
            // processFinalizeScan already notifies the user for PDF-ASSEMBLY
            // failures. This outer net covers every step AFTER assembly (R2
            // store, quota, DB writes): let BullMQ retry until the last attempt,
            // then tell the user instead of dying silently. Idempotency holds —
            // a retry re-enters processFinalizeScan and the result_file_id /
            // status guards skip any already-completed store/charge.
            if (!isLastAttempt) throw err;
            console.error(
              `[upload.worker] finalize_scan exhausted job=${job.id} session=${data.sessionId}:`,
              err,
            );
            await pushMessage(data.lineUserId, [{ type: 'text', text: MSG_PDF_FAILED }]).catch((pushErr) => {
              console.error(`[upload.worker] finalize_scan exhaustion push failed (${data.sessionId}):`, pushErr);
            });
          }
          break;
        }
        case 'convert_to_docx': {
          // Same narrowing capture + last-attempt netting as finalize_scan.
          const data = job.data;
          const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
          try {
            await processConvertToDocx(data, isLastAttempt);
          } catch (err) {
            if (!isLastAttempt) throw err;
            console.error(
              `[upload.worker] convert_to_docx exhausted job=${job.id} msg=${data.lineMessageId}:`,
              err,
            );
            await pushMessage(data.lineUserId, [
              { type: 'text', text: 'แปลงไฟล์เป็น Word ไม่สำเร็จน้า ขอโทษนะคะ ลองส่งใหม่อีกทีน้า' },
            ]).catch((pushErr) => {
              console.error(`[upload.worker] convert_to_docx exhaustion push failed:`, pushErr);
            });
          }
          break;
        }
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
