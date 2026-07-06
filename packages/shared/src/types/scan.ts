export type ScanStatus = 'collecting' | 'processing' | 'done' | 'cancelled';

/** Color mode for the scan-enhance pipeline (migration 019). */
export type ScanMode = 'bw' | 'color';

export interface ScanSessionRecord {
  id: string;
  user_id: string;
  space_id: string | null;
  status: ScanStatus;
  page_count: number;
  result_file_id: string | null;
  /** 'bw' = adaptive threshold, 'color' = normalize/sharpen (migration 019). */
  scan_mode: ScanMode;
  created_at: string;
  expires_at: string;
}

export interface ScanPageRecord {
  id: string;
  session_id: string;
  /** Atomic per-insert ordinal (global BIGSERIAL); use this for page ordering. */
  page_seq: number;
  /** Legacy display ordinal; no longer written (see migration 018). */
  page_number: number | null;
  r2_key: string;
  line_message_id: string | null;
  created_at: string;
}
