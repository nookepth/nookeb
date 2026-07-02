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
  type FileJob,
  type FileRecord,
  type FinalizeScanJob,
  type GenerateThumbnailJob,
  type OcrImageJob,
  type PurgeDeletedJob,
  type UploadFileJob,
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
} from '../services/r2.service';
import { getMessageContent, getProfile, pushMessage } from '../services/line.service';
import {
  ensureUserAndSpace,
  createFileRecord,
  markFileReady,
  markFileError,
  addStorageUsed,
} from '../services/file.service';
import { ensureGroupSpace } from '../services/space.service';
import { purgeDeletedFiles } from '../services/purge.service';
import {
  countPages,
  finishSession,
  getSession,
  insertPage,
  listPages,
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

  // 2. Quota check
  if (user.storage_used >= user.storage_limit) {
    await pushMessage(job.lineUserId, [
      { type: 'text', text: 'พื้นที่เก็บไฟล์เต็มแล้ว 😢 ลบไฟล์เก่าหรืออัปเกรดแผนก่อนนะ' },
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
  });

  // 5. Stream upload to R2
  try {
    const { size } = await uploadStream(r2, r2Key, content.stream, mimeType);
    await markFileReady(supabase, record.id, size);
    await addStorageUsed(supabase, user.id, size);
  } catch (err) {
    await markFileError(supabase, record.id);
    throw err;
  }

  // 6. Images get a thumbnail + OCR — separate jobs so their failure never fails the upload
  if (mimeType.startsWith('image/')) {
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
  }

  // 7. Confirm to the user
  await pushMessage(job.lineUserId, [
    { type: 'text', text: `เก็บ "${job.originalName}" แล้ว ✓\nเปิดดูได้ที่ ${config.WEB_URL}/dashboard` },
  ]);
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

  const pages = await listPages(supabase, session.id);
  if (pages.length === 0) {
    await setSessionStatus(supabase, session.id, 'cancelled');
    await pushMessage(job.lineUserId, [{ type: 'text', text: 'ไม่มีหน้าให้รวมเป็น PDF เลยนะ 🐭' }]);
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

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const name = `สแกน_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.pdf`;

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
  });

  const { size } = await uploadStream(r2, r2Key, Readable.from(Buffer.from(pdfBytes)), 'application/pdf');
  await markFileReady(supabase, record.id, size);
  await addStorageUsed(supabase, session.user_id, size);
  await finishSession(supabase, session.id, record.id, pages.length);

  // Clean up temporary page images (best-effort)
  for (const page of pages) {
    try {
      await deleteObject(r2, page.r2_key);
    } catch {
      /* ignore */
    }
  }

  await pushMessage(job.lineUserId, [
    {
      type: 'text',
      text: `รวม ${pages.length} หน้าเป็น PDF แล้ว ✓\n"${name}"\nเปิดดูได้ที่ ${config.WEB_URL}/dashboard`,
    },
  ]);
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
