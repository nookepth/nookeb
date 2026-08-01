-- 053: diary push OPT-IN — `diary_notification_settings.notification_enabled`.
--
-- NOT auto-applied. Apply BEFORE the API/worker deploy: both diary sweeps in
-- jobs/diaryReminder.job.ts SELECT this column, and routes/diary.ts writes it.
-- Old code against the new schema is safe (the column is additive and every
-- existing writer names its columns explicitly), so the migration may land
-- early.
--
-- ---------------------------------------------------------------------------
-- WHY A SECOND BOOLEAN NEXT TO `is_enabled`
-- ---------------------------------------------------------------------------
-- Migration 028 created `is_enabled BOOLEAN NOT NULL DEFAULT TRUE`, and its own
-- header states what it was for: an IN-APP BANNER on the dashboard, because at
-- the time this project was strictly reply-only. It is TRUE for every user who
-- ever touched the diary settings form, and TRUE by default for everyone who
-- never did.
--
-- The membership system (§17) later pointed the LINE PUSH sweep at that same
-- column. That silently converted an opt-OUT banner preference into an opt-IN
-- for metered push messages that nobody agreed to. Reusing `is_enabled` for the
-- new rule would therefore be wrong in the one direction that costs money:
-- flipping its default to FALSE would also switch off the banner for existing
-- users, and leaving it TRUE would push to everyone.
--
-- So push gets its OWN column, defaulting FALSE. The two are read separately:
--
--   is_enabled           → the in-app dashboard banner   (unchanged, default ON)
--   notification_enabled → LINE push delivery            (NEW,       default OFF)
--
-- No push leaves the app for a user whose `notification_enabled` is FALSE, and
-- a user with no settings row at all is treated as FALSE (absence = not opted
-- in) — see getPushEnabled/listPushOptedInUserIds in services/diary.service.ts.
--
-- ---------------------------------------------------------------------------
-- THE ONE BACKFILL, AND WHY IT IS NOT "EVERYONE"
-- ---------------------------------------------------------------------------
-- Holders of หนูเก็บความทรงจำ (migration 052) PAID for a daily LINE nudge. That
-- purchase IS an explicit opt-in — defaulting them to FALSE would take money and
-- deliver nothing. They are backfilled to TRUE and nobody else is. New
-- purchases are handled in code (createSubscription upserts the row), so this
-- backfill only has to catch subscriptions that predate this migration.
-- ---------------------------------------------------------------------------

ALTER TABLE diary_notification_settings
  ADD COLUMN IF NOT EXISTS notification_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN diary_notification_settings.notification_enabled IS
  'LINE push opt-in (default FALSE). Distinct from is_enabled, which is the in-app dashboard banner. No diary push may be sent unless this is TRUE.';

-- Existing add-on subscribers keep the delivery they bought. Idempotent: a
-- re-run of this migration re-asserts TRUE for the same set and touches nothing
-- else (the WHERE clause makes a second run a no-op).
INSERT INTO diary_notification_settings (user_id, notification_enabled)
SELECT s.user_id, TRUE
FROM diary_addon_subscriptions s
WHERE s.status = 'active'
ON CONFLICT (user_id) DO UPDATE
  SET notification_enabled = TRUE,
      updated_at           = NOW()
WHERE diary_notification_settings.notification_enabled IS DISTINCT FROM TRUE;

-- The sweeps' driving query is "everyone opted in", which on a table with one
-- row per diary user is a small set — a partial index keeps it that way as the
-- table grows, since the vast majority of rows are FALSE.
CREATE INDEX IF NOT EXISTS idx_diary_notification_push_optin
  ON diary_notification_settings (user_id)
  WHERE notification_enabled = TRUE;
