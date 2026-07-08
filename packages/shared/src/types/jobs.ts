import type { LineSource } from './file';

/** BullMQ queue names */
export const FILE_QUEUE = 'nookeb-file-processing';

/**
 * Build a BullMQ custom jobId. Custom jobIds must NOT contain ':' (LINE message
 * ids do), so every char outside [a-zA-Z0-9-_] is replaced with '-'. Shared so
 * the webhook (enqueue) and worker (re-enqueue) can never drift.
 */
export function sanitizeJobId(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^a-zA-Z0-9-_]/g, '-')}`;
}

/** Job: download image from R2 → sharp resize → upload thumbnail → update DB */
export interface GenerateThumbnailJob {
  type: 'generate_thumbnail';
  fileId: string;
}

/** Job: OCR an uploaded image (tesseract) → files.ocr_text for search */
export interface OcrImageJob {
  type: 'ocr_image';
  fileId: string;
}

/** Job: download a scan page from LINE → enhance (scan pipeline) → store in R2 scan-temp → insert scan_page */
export interface AddScanPageJob {
  type: 'add_scan_page';
  sessionId: string;
  lineMessageId: string;
  /**
   * Notify target for quality warnings (too dark / blurry / no edges) — the
   * warnings go through pending-notify (reply-only messaging). Optional
   * for back-compat with jobs enqueued before the scan-enhance release —
   * warnings are simply skipped when absent.
   */
  lineUserId?: string;
}

/** Job: merge all scan_pages into a single PDF → store as a file → confirm */
export interface FinalizeScanJob {
  type: 'finalize_scan';
  sessionId: string;
  lineUserId: string;
  /**
   * Wait-gate re-enqueue counter (migration 023). When finalize_scan finds fewer
   * stored scan_pages than the session's expected_pages, it re-enqueues itself with
   * a short delay and this incremented, until a hard cap — then proceeds with the
   * pages it has and warns the user. Absent/0 on the first enqueue.
   */
  waitAttempt?: number;
}

/** Job: purge R2 objects of files soft-deleted past the retention window */
export interface PurgeDeletedJob {
  type: 'purge_deleted';
}

/**
 * Job: download an image/PDF from LINE CDN → OCR (Mistral, markdown out) →
 * rebuild as an editable .docx → store as a file → REPLY a result card.
 * Retried via BullMQ attempts (LINE CDN ~1h TTL); the handler dedups by a
 * marker line_message_id so a retry never double-stores the .docx.
 */
export interface ConvertToDocxJob {
  type: 'convert_to_docx';
  lineMessageId: string;
  lineUserId: string;
  /** LINE message type of the source: 'image' | 'file' */
  kind: string;
  /** Original file name (file messages) or a generated name (images). */
  originalName: string;
  /** Size declared by LINE (file messages only) — pre-download cap check. */
  fileSize?: number | null;
  /**
   * The source event's reply token, saved at webhook time (reply-only
   * messaging — no pushes). Single-use and short-lived (~1 min): the worker
   * replies the result/error card with it when the conversion is quick; when
   * it's already spent/expired the message is deferred to pending-notify.
   * Optional for back-compat with jobs enqueued before this field existed.
   */
  replyToken?: string | null;
}

/** One upload collected during a user's debounce window. */
export interface BatchItem {
  lineMessageId: string;
  /** file name from LINE (file messages) or a generated name (image/video/audio) */
  originalName: string;
  /** LINE message type: 'image' | 'file' | 'video' | 'audio' */
  kind: string;
  /**
   * Size declared by LINE in the webhook event (file messages only — image/
   * video/audio events carry no size). Used for rate limiting and the pre-download
   * size cap; the worker still verifies against the CDN Content-Length.
   */
  fileSize?: number | null;
}

/**
 * Job: process a debounced batch of uploads sequentially (per-file retry inside
 * the handler, NOT via BullMQ attempts) → send ONE summary Flex push. The handler
 * must never throw, so a batch is never re-run and files are never double-stored.
 */
export interface UploadBatchJob {
  type: 'upload_batch';
  /** UUID identifying this batch for real-time progress tracking */
  batchId: string;
  lineUserId: string;
  lineSource: LineSource;
  lineGroupId: string | null;
  username: string | null;
  items: BatchItem[];
}

export type FileJob =
  | UploadBatchJob
  | GenerateThumbnailJob
  | OcrImageJob
  | AddScanPageJob
  | FinalizeScanJob
  | PurgeDeletedJob
  | ConvertToDocxJob;
