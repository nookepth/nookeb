-- 060_push_log_job_log_suspension.sql
-- TIER 3 of the admin surface — the three tables that turn "the machine is
-- running" into "here is what it actually did".
--
-- TIER 1 (058) answered depth and totals. TIER 2 (059) added the WRITE surface
-- and its audit trail. Everything TIER 1 and 2 can see is CURRENT STATE: a
-- queue's depth right now, a reminder row's terminal stamp. None of it answers
-- "how many pushes went out last Tuesday, to whom, and why did the ones that
-- failed fail" or "is the file queue getting slower". Those are HISTORY, and
-- history needs its own append-only tables because the live rows are
-- overwritten (task_reminders keeps one stamp) or evicted (BullMQ's
-- removeOnComplete drops a completed job the moment it settles).
--
-- APPLY BEFORE THE API/WORKER DEPLOY. Three dependencies, and they fail in
-- deliberately DIFFERENT directions:
--
--   * push_log  — services/push-log.service.ts writes one row per push attempt
--     from inside pushMessage(). It NEVER THROWS: a missing table costs an
--     observability row, and a product that stops messaging because its
--     logbook is unavailable is strictly worse than one that messages without
--     a logbook. Same fail-open reasoning as push-flag.service.ts, which sits
--     two lines above it in the same function.
--
--   * job_log   — services/job-log.service.ts writes from the workers'
--     'completed'/'failed' listeners. Also never throws, for the sharper
--     version of the same reason: a throw inside a BullMQ event listener is an
--     unhandled rejection, and workers/index.ts turns those into process.exit(1).
--     A missing table would restart-loop the worker.
--
--   * users.suspended_at — middleware/auth.ts reads it on every authenticated
--     request. Purely additive and NULL by default, so the reverse deploy order
--     is safe: pre-060 code never selects it, and a NULL means "not suspended",
--     which is every existing user.
--
-- Safe to re-run: every statement is IF NOT EXISTS guarded.

-- ============================================================================
-- 1. push_log — one row per LINE push ATTEMPT, whatever the outcome.
--
-- WHY THIS EXISTS. pushMessage() is the single choke point every LINE push in
-- the product goes through, and until now the only trace a push left was a
-- console line and — for scheduled reminders only — a stamp on task_reminders.
-- That leaves three questions unanswerable:
--
--   * the push allowance is metered and FAILS SILENTLY when spent, so "what did
--     we spend it on" had no answer at all;
--   * push_enabled (059) and TASK_NOTIFICATIONS_ENABLED both suppress pushes
--     SILENTLY by design (a blocked push returns normally so the reminder
--     worker does not burn its attempts), which is correct behaviour and
--     invisible behaviour at the same time;
--   * announcements, cancel notices and review-loop notices have no row
--     anywhere — task_reminders only covers SCHEDULED shots.
--
-- STATUS IS THE POINT. Four terminal outcomes, and the two "blocked" ones are
-- not failures — they are the system doing what it was told:
--   sent           LINE accepted it (2xx)
--   failed         LINE rejected it, or the call timed out
--   blocked_quota  LINE refused it because the monthly allowance is spent
--   blocked_flag   the push_enabled kill switch is off; nothing left the process
-- Keeping blocked_* out of `failed` is what lets the admin page show a delivery
-- rate that means something: a deliberate silence must never look like an
-- outage, which is the exact mistake /admin/notifications' deliveryRate avoids
-- by excluding cancelled shots.
--
-- to_id IS NOT A FOREIGN KEY. It is a LINE id — a user id (U…), a group id (C…)
-- or a room id (R…). Only the first has any chance of matching a users row, and
-- only for someone who has signed into the web app. Same reasoning as
-- admin_audit_log.admin_line_id in 059: the log outlives whatever it points at.
--
-- ref_id is the task id for task_reminder/task_notify, NULL for the diary
-- sweeps and the admin alert. UUID rather than TEXT because every current
-- referent is a tasks.id; it is deliberately not an FK so a deleted task cannot
-- take its delivery history with it.
--
-- NO BODY IS STORED. message_count only. A reminder's Flex card carries the
-- task title, and a diary nudge carries nothing but boilerplate — neither
-- belongs in an ops table that an admin page renders. The count is enough to
-- reconcile against the LINE allowance, which is what this table is for.
--
-- BIGINT IDENTITY: read in created_at order, never joined from elsewhere.
-- Same choice, same reasoning, as admin_audit_log.
-- ============================================================================

CREATE TABLE IF NOT EXISTS push_log (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  to_id         TEXT NOT NULL,
  to_kind       TEXT NOT NULL CHECK (to_kind IN ('user', 'group', 'room')),
  context       TEXT NOT NULL,
  ref_id        UUID,
  message_count INT NOT NULL,
  status        TEXT NOT NULL
                CHECK (status IN ('sent', 'failed', 'blocked_quota', 'blocked_flag')),
  http_status   INT,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "what happened recently" — the default ordering of every read.
CREATE INDEX IF NOT EXISTS idx_push_log_time ON push_log (created_at DESC);
-- "how is the reminder path doing" — the admin page's context filter, composite
-- so the filter and its ordering are served without a sort.
CREATE INDEX IF NOT EXISTS idx_push_log_context ON push_log (context, created_at DESC);
-- "did this group / this user actually get messaged" — the support question.
CREATE INDEX IF NOT EXISTS idx_push_log_to ON push_log (to_id, created_at DESC);

-- Deny-all backstop (038). The API/worker use the service-role key and bypass
-- RLS; enabling it with no policy means a leaked anon key reads nothing.
ALTER TABLE push_log ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE push_log IS
  'Append-only record of every LINE push attempt (060). Written by services/push-log.service.ts from inside pushMessage(); never throws, so a write failure costs a row and nothing else. blocked_quota/blocked_flag are deliberate silences, not failures — do not fold them into failed.';

-- ============================================================================
-- 2. job_log — one row per SETTLED BullMQ job, across all four queues.
--
-- WHY BULLMQ'S OWN COUNTS ARE NOT ENOUGH. Every queue in this product settles
-- jobs with removeOnComplete (the file queue keeps a short window, the
-- membership and sheets queues remove immediately — and sheets_sync MUST,
-- because a lingering settled job with a stable id silently swallows the next
-- sync for that task). So Queue.getJobCounts() reports a completed count that
-- is an artifact of the eviction policy, not a throughput measurement, and a
-- job that succeeded an hour ago has left no trace anywhere. "Is the worker
-- keeping up?" and "did add_scan_page get slower after the OpenCV change?" are
-- unanswerable without this table.
--
-- duration_ms is nullable because it is derived from BullMQ's finishedOn -
-- processedOn, and a job that never entered processing (removed while waiting)
-- has neither. NULL means "not measured", never 0 — the same rule the Sheets
-- workspace's blank cells follow, and for the same reason: a fabricated 0 drags
-- every average toward a value nothing ever took.
--
-- job_name is the job's own `type` discriminator ('upload_batch',
-- 'task_reminder', …), not BullMQ's job name, so the rows group the way an
-- engineer thinks about the work.
--
-- NO PAYLOAD, NO ERROR TEXT. The failure REASON belongs in the worker log and
-- in BullMQ's own failed set (which /admin/system/queues already surfaces with
-- retry/remove buttons). This table answers "how much, how fast, how often did
-- it fail" — a shape question. Storing stack traces here would duplicate the
-- triage surface and grow without bound.
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue       TEXT NOT NULL,
  job_name    TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  duration_ms INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_log_time ON job_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_log_queue ON job_log (queue, created_at DESC);

ALTER TABLE job_log ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE job_log IS
  'Append-only throughput history for the four BullMQ queues (060). Written from the workers'' completed/failed listeners via services/job-log.service.ts; never throws, because a rejection inside a BullMQ listener becomes an unhandledRejection and workers/index.ts exits(1) on those. duration_ms NULL = not measured, never 0.';

-- ============================================================================
-- 3. users.suspended_at / suspended_reason — the account-level stop.
--
-- The gap TIER 2 left. An admin could already zero a quota, pin a locker
-- ceiling to 0 bytes and revoke every session — but none of those STOPS an
-- account: the user logs in again a second later with a fresh JWT. Suspension
-- is the missing verb, and it is enforced in middleware/auth.ts, which is the
-- one place every authenticated request passes through.
--
-- TWO COLUMNS, NOT A BOOLEAN. suspended_at doubles as the timestamp and the
-- flag (NULL = active), which means "when" is never a separate question, and
-- the reason travels with it — a suspension with no recorded reason is one an
-- admin cannot justify later, and the audit row alone would not survive a
-- support agent looking at the user record itself.
--
-- WHAT IT DOES NOT DO. Suspension does not touch the LINE bot: the webhook is
-- signature-authenticated, not JWT-authenticated, so a suspended user can still
-- message the OA and still have files stored. That is a deliberate boundary,
-- not an oversight — cutting the chat path is a different, louder decision (it
-- would silently swallow uploads a user believes were saved), and it needs its
-- own design. This column stops the WEB/LIFF surface only.
--
-- Suspension also bumps users.session_version (see POST /admin/users/:id/
-- suspend), so existing tokens die immediately rather than waiting for the
-- middleware's 60 s cache. The column check is what stops a NEW login.
--
-- Purely additive, NULL default, safe in either deploy order.
-- ============================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS suspended_reason TEXT DEFAULT NULL;

COMMENT ON COLUMN users.suspended_at IS
  'NULL = active. Non-NULL blocks every authenticated API request with 403 ACCOUNT_SUSPENDED (middleware/auth.ts). Does NOT block the LINE webhook path — that is signature-authenticated and is a separate decision. Set only by POST /admin/users/:id/suspend; every set is recorded in admin_audit_log.';

COMMENT ON COLUMN users.suspended_reason IS
  'Free text, max 500 chars, required when suspending. Cleared on unsuspend. Kept on the user row rather than only in admin_audit_log so the reason is visible wherever the account is.';
