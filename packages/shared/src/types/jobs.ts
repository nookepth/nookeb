import type { LineSource } from './file';

/** BullMQ queue names */
export const FILE_QUEUE = 'nookeb-file-processing';

/** Job: download from LINE CDN → upload to R2 → update DB → push confirm */
export interface UploadFileJob {
  type: 'upload_file';
  lineMessageId: string;
  lineUserId: string;
  lineSource: LineSource;
  lineGroupId: string | null;
  /** file name from LINE (file messages only — images get a generated name) */
  originalName: string;
  /** MIME hint from the event; worker trusts the CDN Content-Type over this */
  mimeType: string | null;
  replyToken: string | null;
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

/** Job: download a scan page from LINE → store in R2 scan-temp → insert scan_page */
export interface AddScanPageJob {
  type: 'add_scan_page';
  sessionId: string;
  lineMessageId: string;
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

export type FileJob =
  | UploadFileJob
  | GenerateThumbnailJob
  | OcrImageJob
  | AddScanPageJob
  | FinalizeScanJob
  | PurgeDeletedJob;
