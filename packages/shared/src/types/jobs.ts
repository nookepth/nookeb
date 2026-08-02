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
   * Notify target for quality warnings (too dark / too blurry) — the warnings
   * go through pending-notify (reply-only messaging). Optional for back-compat
   * with jobs enqueued before the scan-enhance release — warnings are simply
   * skipped when absent.
   *
   * Edge-detection failure is NOT reported here: it falls back to the full
   * frame and ships a usable page, so it is logged server-side only.
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
 * Job: walk the whole R2 bucket against every key-bearing DB column, report
 * drift, and flip files rows whose object is gone to status='error'.
 *
 * ONE-OFF, NEVER REPEATABLE. An admin triggers it from
 * POST /admin/system/r2-reconcile; there is no schedule, deliberately —
 * listing the entire bucket is O(objects) network round trips, and a standing
 * delayed job on the file queue also pins the idle worker's blocking poll to
 * 10s (the reason scheduleRepeatableJobs uses a plain setInterval).
 *
 * De-duplicated by the fixed jobId 'r2_reconcile_singleton' so two admins
 * pressing the button cannot start two full-bucket walks. It carries no fields:
 * the whole bucket is the only scope it has.
 *
 * NEVER DELETES AN R2 OBJECT — see the header of jobs/r2Reconcile.job.ts for
 * why the orphan direction is report-only.
 */
export interface R2ReconcileJob {
  type: 'r2_reconcile';
  /** LINE id of the admin who triggered it — recorded in admin_audit_log. */
  requestedByLineId: string;
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

/**
 * Job: download a diary photo from LINE CDN → validate (jpg/png/webp, size cap)
 * → store in R2 `diary/{userId}/...` → insert diary_entries row (one per
 * Bangkok day) → 400px thumbnail → REPLY a result card. Retried via BullMQ
 * attempts (LINE CDN ~1h TTL); the handler dedups by line_message_id and the
 * one-live-entry-per-day unique index (migration 028), so a retry never
 * double-stores or double-charges.
 */
export interface CreateDiaryEntryJob {
  type: 'create_diary_entry';
  lineMessageId: string;
  lineUserId: string;
  /** caption typed while diary mode was armed ('' = photo only) */
  caption: string;
  /** Bangkok calendar day the entry belongs to, fixed at webhook time */
  entryDate: string;
  /**
   * The source event's reply token, saved at webhook time (reply-only
   * messaging — no pushes). The worker replies the result/error card with it
   * when the job is quick; spent/expired tokens defer to pending-notify.
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
  | R2ReconcileJob
  | ConvertToDocxJob
  | CreateDiaryEntryJob;

/** The fixed jobId that makes r2_reconcile a singleton. Shared so the enqueuer
 *  (routes/admin-ops.ts) and the status reader cannot drift. */
export const R2_RECONCILE_JOB_ID = 'r2_reconcile_singleton';
