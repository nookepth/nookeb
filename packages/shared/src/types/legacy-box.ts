import type { LegacyBoxThemeId } from '../legacy-box-themes';
import type { LegacyBoxOccasionId } from '../legacy-box-occasions';
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
  /** authoring metadata (migration 034) — NULL on every box created before it */
  occasion: string | null;
  /** sender's closing line; NULL falls back to DEFAULT_TAGLINE on the reveal page */
  tagline: string | null;
  /**
   * R2 key of the sender's voice message (migration 035), or NULL when the box
   * has none — the common case, and permanent for every pre-035 box. Server-built
   * only; never accepted from a client and never sent to one.
   */
  audio_key: string | null;
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
  occasion: LegacyBoxOccasionId | null;
  tagline: string | null;
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
  /** authoring metadata — safe to expose: it says nothing about WHO sent the box */
  occasion: LegacyBoxOccasionId | null;
  /** already resolved to DEFAULT_TAGLINE by the API when the box has none */
  tagline: string;
  photos: { url: string; sortOrder: number }[];
  /**
   * Presigned GET for the sender's voice message (1h), or null when the box has
   * none. Presigned rather than public for the same reason the photos are: the
   * slug is the credential, and a recording of someone's voice must not be
   * reachable by anyone who didn't get the link. Carries no PII — the API never
   * reveals who recorded it (see the senderName note on VoicePlayer).
   */
  audio_url?: string | null;
  stickerLayout: StickerPlacement[];
  viewCount: number;
}
