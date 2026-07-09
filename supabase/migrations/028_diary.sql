-- 028_diary.sql
-- "ไดอารี่ 365 วัน" (My Diary) — 1 photo + caption per Bangkok calendar day.
--
-- Diary photos are DELIBERATELY isolated from the files table (they never show
-- in the locker, have their own template rendering, and their own one-per-day
-- rule). Images live in R2 under `diary/{user_id}/{year}/...` and the columns
-- store R2 KEYS, not URLs — downloads always go through 1-hour presigned URLs
-- (engineering rule 5), so a stored public URL would be wrong here.
--
-- Quota: diary images are charged to the user's PERSONAL quota via the atomic
-- increment_personal_storage RPC (migration 014) — file_size is kept on the row
-- so a delete can refund exactly what was charged.
--
-- One entry per user per day is enforced by a PARTIAL unique index over live
-- rows (deleted_at IS NULL) instead of a plain UNIQUE(user_id, entry_date):
-- rows are soft-deleted only (project rule 6), and a plain constraint would
-- permanently block re-recording a day after deleting that day's entry.
--
-- NOT auto-applied — run via the Supabase SQL editor BEFORE deploying the
-- API/worker code that reads these tables (the ไดอารี่ command errors politely
-- but uselessly without them).

CREATE TABLE IF NOT EXISTS diary_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_date      DATE NOT NULL,                 -- Bangkok (UTC+7) calendar day
  image_key       TEXT NOT NULL,                 -- R2 key of the original photo
  thumbnail_key   TEXT,                          -- R2 key of the 400px grid thumb (webp)
  mime_type       TEXT NOT NULL DEFAULT 'image/jpeg',
  file_size       BIGINT NOT NULL DEFAULT 0,     -- bytes charged to personal quota
  caption         TEXT NOT NULL DEFAULT '',
  template_id     VARCHAR(50) NOT NULL DEFAULT 'classic_pink',
  day_number      INT,                           -- nth diary entry (1..365) at insert time
  line_message_id TEXT,                          -- source LINE message — worker retry dedup
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,                   -- soft delete only (rule 6)
  purged_at       TIMESTAMPTZ                    -- stamped by the daily purge once R2 objects are gone
);

-- One LIVE entry per user per day (soft-deleted rows don't block a redo).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_diary_user_date_live
  ON diary_entries (user_id, entry_date)
  WHERE deleted_at IS NULL;

-- Grid/list reads: all live entries for a user, newest first.
CREATE INDEX IF NOT EXISTS idx_diary_user_date
  ON diary_entries (user_id, entry_date DESC)
  WHERE deleted_at IS NULL;

-- Worker retry dedup: find the live entry a LINE message already created.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_diary_line_message_live
  ON diary_entries (line_message_id)
  WHERE deleted_at IS NULL AND line_message_id IS NOT NULL;

-- Daily purge scan: soft-deleted rows whose R2 objects still exist.
CREATE INDEX IF NOT EXISTS idx_diary_purge_pending
  ON diary_entries (deleted_at)
  WHERE deleted_at IS NOT NULL AND purged_at IS NULL;

-- Reminder preferences. NOTE: this project is reply-only LINE messaging (no
-- pushes, ever — see CLAUDE.md), so the reminder is delivered as an IN-APP
-- banner on the dashboard (the web client compares notify_time against the
-- current time in `timezone` and shows the banner when today has no entry).
-- The table still records the user's chosen time/enabled state so a future
-- notification channel can reuse it unchanged.
CREATE TABLE IF NOT EXISTS diary_notification_settings (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notify_time TIME NOT NULL DEFAULT '20:00:00',
  is_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  timezone    VARCHAR(100) NOT NULL DEFAULT 'Asia/Bangkok',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS backstop, mirroring files (the API/worker use the service-role key which
-- bypasses RLS — ownership is enforced in the routes; this guards direct access).
ALTER TABLE diary_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE diary_notification_settings ENABLE ROW LEVEL SECURITY;
