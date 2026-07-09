/**
 * "ไดอารี่ 365 วัน" (My Diary) — one photo + caption per Bangkok calendar day
 * (migration 028). Entries are isolated from the files table: they never show
 * in the locker and carry their own template rendering + one-per-day rule.
 */

export interface DiaryEntryRecord {
  id: string;
  user_id: string;
  /** Bangkok (UTC+7) calendar day, 'YYYY-MM-DD' */
  entry_date: string;
  /** R2 key of the original photo (presigned on read — never a stored URL) */
  image_key: string;
  /** R2 key of the 400px grid thumbnail (webp), null until generated */
  thumbnail_key: string | null;
  mime_type: string;
  /** bytes charged to the user's personal quota (refunded on delete) */
  file_size: number;
  caption: string;
  template_id: string;
  /** nth diary entry (1..365) assigned at insert time */
  day_number: number | null;
  line_message_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  purged_at: string | null;
}

/** Diary entry shape returned to the web dashboard (no internal storage keys). */
export interface DiaryEntryDto {
  id: string;
  entryDate: string;
  dayNumber: number | null;
  caption: string;
  templateId: string;
  createdAt: string;
  /** presigned thumbnail URL (expires 1 hour) — set by the API when available */
  thumbnailUrl?: string | null;
  /** presigned full-image URL (expires 1 hour) — set by the API on detail reads */
  imageUrl?: string | null;
}

export function toDiaryEntryDto(e: DiaryEntryRecord): DiaryEntryDto {
  return {
    id: e.id,
    entryDate: e.entry_date,
    dayNumber: e.day_number,
    caption: e.caption,
    templateId: e.template_id,
    createdAt: e.created_at,
  };
}

export interface DiaryNotificationSettingsDto {
  /** 'HH:MM' (seconds dropped for the web time picker) */
  notifyTime: string;
  isEnabled: boolean;
  timezone: string;
}

export interface DiaryStreakResponse {
  /** consecutive days ending today or yesterday (Bangkok) */
  currentStreak: number;
  totalEntries: number;
  lastEntryDate: string | null;
}

export interface DiaryTodayStatusResponse {
  submitted: boolean;
  /** today's Bangkok calendar date, 'YYYY-MM-DD' */
  entryDate: string;
  notification: DiaryNotificationSettingsDto;
}
