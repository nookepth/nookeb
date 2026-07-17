-- 033_legacy_boxes.sql
-- กล่องของขวัญ (Legacy Box) — shareable digital gift boxes: 1–10 photos + a
-- message behind a public slug URL, opened with an animated gift-box reveal.
--
-- Structurally isolated like the diary (028) and vault (031): its own tables,
-- its own R2 prefix (`legacy-box/{user_id}/{box_id}/{uuid}.webp`), web-only
-- write path (no LINE webhook / worker writes). Photos are re-encoded to webp
-- with EXIF stripped before storage, and charged to users.storage_used.
--
-- Lifecycle: soft delete (deleted_at) refunds total_bytes immediately; the
-- daily purge removes the R2 objects + child photo rows after 7 days and
-- stamps purged_at on the box row, which is kept as a tombstone (rule 6 —
-- child legacy_box_photos rows are hard-deleted; they only carry storage keys).
--
-- NOT auto-applied — run in the Supabase SQL editor BEFORE deploying the
-- legacy-box code (the /legacy-box routes error without these tables).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE legacy_boxes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 9 random bytes → 12-char URL-safe token; the public page's credential.
  slug        TEXT NOT NULL UNIQUE
              DEFAULT translate(encode(gen_random_bytes(9),'base64'),'+/','-_'),
  title       TEXT NOT NULL DEFAULT 'กล่องของขวัญ'
              CHECK (char_length(title) <= 60),
  message     TEXT NOT NULL DEFAULT ''
              CHECK (char_length(message) <= 500),
  -- keep in sync with THEMES in packages/shared/src/legacy-box-themes.ts
  theme       VARCHAR(20) NOT NULL DEFAULT 'rose'
              CHECK (theme IN ('rose','mint','butter','lilac','sky','peach')),
  total_bytes BIGINT NOT NULL DEFAULT 0,
  view_count  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ,
  purged_at   TIMESTAMPTZ
);

CREATE TABLE legacy_box_photos (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  box_id     UUID NOT NULL REFERENCES legacy_boxes(id) ON DELETE CASCADE,
  r2_key     TEXT NOT NULL,
  mime_type  TEXT NOT NULL,
  file_size  BIGINT NOT NULL,
  sort_order INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_legacy_boxes_user_live
  ON legacy_boxes (user_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE INDEX idx_legacy_boxes_purge
  ON legacy_boxes (deleted_at) WHERE deleted_at IS NOT NULL
  AND purged_at IS NULL;

CREATE INDEX idx_legacy_box_photos_box
  ON legacy_box_photos (box_id, sort_order);

-- Atomic view counter (never read-modify-write from the app layer — rule 8's
-- discipline applied to view counts; concurrent opens must not lose ticks).
CREATE OR REPLACE FUNCTION increment_box_views(p_box_id UUID)
RETURNS void LANGUAGE sql AS $$
  UPDATE legacy_boxes SET view_count = view_count + 1 WHERE id = p_box_id;
$$;
