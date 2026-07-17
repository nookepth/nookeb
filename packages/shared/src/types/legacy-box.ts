import type { LegacyBoxThemeId } from '../legacy-box-themes';
import type { StickerPlacement } from '../legacy-box-stickers';

/**
 * กล่องของขวัญ (Legacy Box) — a shareable digital gift: 1–10 photos + a message
 * behind a slug URL, wrapped in an animated gift-box reveal (migration 033).
 * Isolated like the diary/vault: own tables, own R2 prefix
 * (`legacy-box/{user_id}/{box_id}/…`), no LINE-webhook write path.
 */

export interface LegacyBoxRecord {
  id: string;
  user_id: string;
  /** URL-safe public token — the credential for the open page */
  slug: string;
  title: string;
  message: string;
  theme: string;
  total_bytes: number;
  view_count: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  purged_at: string | null;
}

export interface LegacyBoxPhotoRecord {
  id: string;
  box_id: string;
  r2_key: string;
  mime_type: string;
  file_size: number;
  sort_order: number;
  created_at: string;
}

/** Owner-facing box shape (list page). Never includes r2 keys. */
export interface LegacyBoxDto {
  id: string;
  slug: string;
  shareUrl: string;
  title: string;
  message: string;
  theme: LegacyBoxThemeId;
  photoCount: number;
  totalBytes: number;
  viewCount: number;
  createdAt: string;
  /** presigned URL of the first photo (short TTL) — list-card thumbnail */
  coverUrl: string | null;
}

export interface LegacyBoxListResponse {
  boxes: LegacyBoxDto[];
  total: number;
  /** sum of view_count across all live boxes — dashboard card stat */
  totalViews: number;
}

/** PUBLIC open-page payload — must never carry user_id or any creator PII. */
export interface LegacyBoxOpenResponse {
  title: string;
  message: string;
  theme: LegacyBoxThemeId;
  photos: { url: string; sortOrder: number }[];
  stickerLayout: StickerPlacement[];
  viewCount: number;
}
