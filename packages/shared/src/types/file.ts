export type FileStatus = 'pending' | 'processing' | 'ready' | 'error';

/**
 * Virus-scan outcome recorded per file (null = uploaded before scanning
 * existed / feature disabled). Named FileScanStatus because ScanStatus is
 * already taken by the scan-session (scan-to-PDF) status in scan.ts.
 */
export type FileScanStatus = 'clean' | 'skipped_size' | 'scan_failed' | 'malicious';

export type LineSource = 'user' | 'group' | 'room';

export interface FileRecord {
  id: string;
  space_id: string;
  folder_id: string | null;
  uploaded_by: string | null;
  original_name: string;
  display_name: string | null;
  mime_type: string;
  file_size: number;
  extension: string | null;
  r2_key: string;
  r2_bucket: string;
  thumbnail_key: string | null;
  line_message_id: string | null;
  line_source: LineSource | null;
  line_group_id: string | null;
  status: FileStatus;
  scan_status: FileScanStatus | null;
  ocr_text: string | null;
  captured_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** set by the daily purge job once the R2 objects are removed (row kept as tombstone) */
  purged_at: string | null;
  /** owning team when uploaded via a team-bound LINE group (migration 005); charged to team quota */
  team_id?: string | null;
}

/** File shape returned to the web dashboard (no internal storage keys). */
export interface FileDto {
  id: string;
  spaceId: string;
  folderId: string | null;
  name: string;
  mimeType: string;
  fileSize: number;
  extension: string | null;
  status: FileStatus;
  createdAt: string;
  /** presigned thumbnail URL (images only, expires 1 hour) — set by the API */
  thumbnailUrl?: string | null;
  /** tag ids attached to this file — set by the API */
  tagIds?: string[];
}

export interface FileListResponse {
  files: FileDto[];
  total: number;
  page: number;
  limit: number;
}

export function toFileDto(f: FileRecord): FileDto {
  return {
    id: f.id,
    spaceId: f.space_id,
    folderId: f.folder_id,
    name: f.display_name ?? f.original_name,
    mimeType: f.mime_type,
    fileSize: f.file_size,
    extension: f.extension,
    status: f.status,
    createdAt: f.created_at,
  };
}
