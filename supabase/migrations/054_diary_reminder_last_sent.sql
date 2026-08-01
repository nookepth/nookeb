-- 054: per-day idempotency for the §17 diary reminder sweep —
--      `diary_notification_settings.last_push_date`.
--
-- NOT auto-applied. Apply BEFORE the API/worker deploy: runDiaryReminderSweep
-- in jobs/diaryReminder.job.ts SELECTs and UPDATEs this column on every run.
-- Old code against the new schema is safe (additive, and every existing writer
-- names its columns explicitly), so the migration may land early.
--
-- ---------------------------------------------------------------------------
-- WHY THIS COLUMN EXISTS NOW AND DID NOT BEFORE
-- ---------------------------------------------------------------------------
-- The §17 sweep used to run ONCE a day, on a 20:00 ICT cron, and pushed to
-- every opted-in user in that single pass. `notify_time` — the time the user
-- actually picked, stored since migration 028 — was ignored, and the job's own
-- comment said so: honouring it needs an HOURLY sweep.
--
-- The sweep is hourly as of this migration. That change is what creates the
-- need for a day claim. Once a day, "did we already send?" is answered by the
-- cron firing once. Twenty-four times a day it is not:
--
--   * a user's notify_time matches exactly one hour, but a job RETRY (attempts:
--     3 on the membership queue) re-runs the whole sweep for that same hour;
--   * a worker restart mid-run replays the hour;
--   * a user who edits notify_time from 09:00 to 21:00 after the 09:00 push
--     would land in BOTH windows on the same day.
--
-- The paid add-on (migration 052) already solved this with
-- `diary_addon_logs UNIQUE(user_id, date)`. This is deliberately NOT reused:
-- that table is the ADD-ON's delivery ledger, keyed one row per user per day,
-- and writing plan-based §17 sends into it would make the two features
-- cannibalise each other's idempotency key — a user holding both would silently
-- lose one of their two nudges, and the add-on's "why did I not get a nudge"
-- audit trail would start containing rows it never sent.
--
-- ---------------------------------------------------------------------------
-- WHY A DATE COLUMN RATHER THAN A LEDGER TABLE
-- ---------------------------------------------------------------------------
-- §17 needs no audit trail: it is metered by the ordinary `diary_reminders`
-- quota (free 5/month), which already records the count, and its skips are not
-- user-visible the way a paid subscriber's are. All that is missing is "have we
-- already sent today", which is one date on a table that already has exactly
-- one row per user.
--
-- It is claimed with a CONDITIONAL UPDATE — `SET last_push_date = today WHERE
-- last_push_date IS DISTINCT FROM today RETURNING user_id` — so the claim is
-- atomic in one statement: two concurrent sweeps race, one gets the row back
-- and pushes, the other gets nothing and stands down. Same shape as the add-on's
-- INSERT ... ON CONFLICT claim, without a second table.
--
-- The date is a BANGKOK calendar date (the value bangkokDate() produces), NOT a
-- UTC date. Every date in this product is Bangkok wall clock; storing UTC here
-- would roll the day over at 07:00 ICT and hand some users two nudges on the
-- same afternoon.
-- ---------------------------------------------------------------------------

ALTER TABLE diary_notification_settings
  ADD COLUMN IF NOT EXISTS last_push_date DATE;

COMMENT ON COLUMN diary_notification_settings.last_push_date IS
  'Bangkok calendar date of the last §17 diary reminder push. The hourly sweep claims the day with a conditional UPDATE, so a retry or a notify_time change cannot double-push. NULL = never pushed.';

-- The sweep''s driving query is "opted in AND not yet pushed today". The
-- existing idx_diary_notification_push_optin (migration 053) already narrows to
-- the opted-in set, which is the selective half; this one lets the claim UPDATE
-- find its row without re-scanning that set as it grows.
CREATE INDEX IF NOT EXISTS idx_diary_notification_last_push
  ON diary_notification_settings (last_push_date)
  WHERE notification_enabled = TRUE;
