-- 057_retire_task_pro_fake_doors.sql
-- Retires the TWO ระบบตามงาน Pro fake doors — task_auto_reminder ("เตือนงาน
-- อัตโนมัติ") and task_voice_command ("สั่งงานด้วยเสียง"). They were locked rows
-- on the LIFF task pages that recorded demand and nothing else: no scheduler, no
-- microphone, no webhook behind either one. The UI, the authenticated
-- POST/GET /pro-interest routes and the admin task panel are gone in the same
-- change.
--
-- WHAT THIS IS NOT:
--   * NOT the real reminder system. tasks.reminder_intervals / task_reminders /
--     the nookeb-task-reminders queue (migrations 047/051/055/056) are a shipped,
--     live feature and are untouched here.
--   * NOT the gift-box demand test. pro_interest_log (migration 034), its
--     anonymous POST /api/pro-interest route and admin_pro_interest_giftbox all
--     stay exactly as they are.
--
-- HISTORY IS PRESERVED. No row is deleted: the `pro_interest` table, its rows,
-- its index and its RLS backstop all remain, and the pro_interest_view/click/
-- dismiss rows already in usage_events are left alone. This migration only
-- closes the column to NEW values and removes the task-only aggregate RPCs.
--
-- NOT auto-applied — run in the Supabase SQL editor. Order does not matter
-- relative to the deploy: the code that wrote these values is being removed in
-- the same change, so applying this before OR after the API deploy is safe.

-- ---------------------------------------------------------------------------
-- 1. Close pro_interest.feature_id to new values.
-- ---------------------------------------------------------------------------
-- Migration 040 created an inline CHECK allowing exactly the two fake-door ids.
-- Dropping both leaves the allowed set EMPTY, which a CHECK cannot spell as
-- `IN ()` — so the honest encoding is CHECK (false): the table is closed for
-- writes and open for reads. NOT VALID is load-bearing, not a shortcut: it tells
-- Postgres to skip re-validating the rows already there, which is precisely the
-- "keep the history, refuse new writes" behaviour we want. Without it the ALTER
-- would fail against any existing row.
--
-- If a future demand test wants this table back, drop this constraint and add a
-- fresh IN (...) list naming the new features.
ALTER TABLE pro_interest DROP CONSTRAINT IF EXISTS pro_interest_feature_id_check;
ALTER TABLE pro_interest
  ADD CONSTRAINT pro_interest_feature_id_check CHECK (false) NOT VALID;

COMMENT ON TABLE pro_interest IS
  'Retired 2026-08-02 (migration 057). Historical demand-test records for the two '
  'ระบบตามงาน Pro fake doors (task_auto_reminder / task_voice_command). Read-only: '
  'the CHECK(false) constraint blocks new inserts. Not related to task_reminders.';

-- ---------------------------------------------------------------------------
-- 2. Drop the task-only admin RPC (migration 042, Section 2).
-- ---------------------------------------------------------------------------
-- GET /admin/pro-interest no longer calls it; the gift-box RPC is untouched.
DROP FUNCTION IF EXISTS admin_pro_interest_tasks(TIMESTAMPTZ);

-- ---------------------------------------------------------------------------
-- 3. Re-shape the daily trend RPC to gift-box only.
-- ---------------------------------------------------------------------------
-- NOTE for anyone following the retirement plan: there is no
-- `admin_pro_interest_tasks_daily`. Migration 042 shipped ONE shared spine,
-- `admin_pro_interest_daily(p_days)`, returning (day, task_clicks, giftbox_taps)
-- so the dashboard could draw two independent charts. With the task fake doors
-- gone the task_clicks column would be permanently zero, so the column is
-- removed rather than left lying. Changing the return type requires DROP +
-- CREATE — CREATE OR REPLACE cannot alter an OUT-parameter list.
DROP FUNCTION IF EXISTS admin_pro_interest_daily(INT);

CREATE OR REPLACE FUNCTION admin_pro_interest_daily(p_days INT)
RETURNS TABLE(day DATE, giftbox_taps BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT (created_at AT TIME ZONE 'Asia/Bangkok')::date AS day, COUNT(*)::BIGINT
  FROM pro_interest_log
  WHERE created_at >= NOW() - (p_days || ' days')::interval
  GROUP BY 1
  ORDER BY 1;
$$;
