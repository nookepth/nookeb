export type ScanStatus = 'collecting' | 'processing' | 'done' | 'cancelled';

export interface ScanSessionRecord {
  id: string;
  user_id: string;
  space_id: string | null;
  status: ScanStatus;
  page_count: number;
  result_file_id: string | null;
  created_at: string;
  expires_at: string;
}

export interface ScanPageRecord {
  id: string;
  session_id: string;
  page_number: number;
  r2_key: string;
  line_message_id: string | null;
  created_at: string;
}
