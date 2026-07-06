import type { LineSource } from './file';

/** BullMQ queue names */
export const FILE_QUEUE = 'nookeb-file-processing';

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
   * Push target for quality warnings (too dark / blurry / no edges). Optional
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
}

/** Job: purge R2 objects of files soft-deleted past the retention window */
export interface PurgeDeletedJob {
  type: 'purge_deleted';
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
  | PurgeDeletedJob;
