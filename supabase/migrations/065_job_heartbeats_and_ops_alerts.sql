-- 065: job_heartbeats + ops_alerts — FIX 4 (cleanup depended on one worker
-- process with no alert) and FIX 5 (a silent per-run batch cap).
--
-- NOT auto-applied. ORDER-INDEPENDENT vs the deploy in BOTH directions, and
-- everything that touches these tables FAILS OPEN:
--   old DB + new code → the heartbeat writer and the alert raiser swallow the
--                       missing-table error and carry on. This is observability;
--                       it must never be able to break the thing it observes.
--                       (Same rule as push_log/job_log in migration 060.)
--   new DB + old code → nothing writes them; the watchdog is simply not running.
-- Safe to re-run.
--
-- ---------------------------------------------------------------------------
-- FIX 4 — WHAT WAS BROKEN
-- ---------------------------------------------------------------------------
--
-- The sheets-trial expiry sweep runs in exactly one place: the membership
-- worker's 15-minute repeatable. If that worker is down, wedged, or its
-- repeatable was lost from Redis, nothing revokes anybody's Google credentials
-- — and the only evidence was a console.log at the end of a run that, by
-- definition, is not printed when the run does not happen.
--
-- "No log line" is invisible. Absence cannot be grepped for. So the sweep now
-- records a POSITIVE fact after each successful run, and something else watches
-- for that fact going stale.
--
-- THE WATCHDOG DELIBERATELY DOES NOT RUN IN THE WORKER. A worker that is dead
-- cannot notice that it is dead. The staleness check therefore lives in the API
-- process (services/sweep-watchdog.ts), which is a separate Railway service
-- with a separate lifecycle — the only arrangement in which "the worker stopped"
-- is detectable at all.

CREATE TABLE IF NOT EXISTS job_heartbeats (
  -- The job's own name, e.g. 'sheets_trial_expiry'. One row per job, forever;
  -- this is CURRENT STATE, not history (job_log, migration 060, is the history).
  job_name TEXT PRIMARY KEY,

  -- The number the watchdog compares against. Advanced ONLY by a run that
  -- completed without throwing — a run that failed leaves this where it was,
  -- which is the whole point: "it ran and crashed" and "it did not run" are
  -- both "it has not succeeded since X".
  last_success_at TIMESTAMPTZ,

  -- Advanced by every attempt, successful or not. The gap between this and
  -- last_success_at is what distinguishes a crashing job from a stopped one.
  last_run_at TIMESTAMPTZ,

  -- Reset to 0 on success. Surfaced so a job failing every single run is
  -- visible even while last_run_at looks perfectly healthy.
  consecutive_failures INT NOT NULL DEFAULT 0,

  -- FIX 5. Incremented when a run comes back holding EXACTLY its batch cap,
  -- reset to 0 when it does not. A full batch is not itself a problem — it is
  -- one run doing its job — but N in a row means the queue is draining slower
  -- than it fills, which is the only way the 200/run cap can hurt anyone and
  -- was previously invisible.
  consecutive_full_batches INT NOT NULL DEFAULT 0,

  -- The last run's own result object, verbatim. Small, and it is what turns
  -- "the sweep ran" into "the sweep ran and deferred 180 of 200 users".
  last_result JSONB,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE job_heartbeats IS
  'FIX 4/5 (065): one row per scheduled job holding its last successful run, failure streak and full-batch streak. Current state only — job_log (060) is the history. Read by the API-side watchdog, which must not live in the process it watches.';

-- ---------------------------------------------------------------------------
-- ops_alerts — somewhere for an alert to LAND
--
-- The project has no Sentry and no PagerDuty. What it does have is an on-call
-- surface people already look at (/admin/system) and one already-proven paging
-- channel (a LINE push to ADMIN_LINE_USER_ID, which upload.worker.ts uses for a
-- permanently-failed job). This table is the durable half of that pair: the
-- push is best-effort and disappears into a chat, the row persists and can be
-- listed, counted and resolved.
--
-- It is also what makes the push RATE-LIMITED. A sweep that has been down for a
-- day would otherwise send 96 identical LINE messages, which is not an alert —
-- it is noise that trains people to ignore the channel, and it burns metered
-- push quota (rule 10).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ops_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stable identity for "the same problem", e.g. 'sweep_stalled:sheets_trial_expiry'.
  -- Re-raising an open alert updates the existing row instead of adding one.
  key TEXT NOT NULL,

  severity TEXT NOT NULL DEFAULT 'warning',  -- 'warning' | 'critical'
  title TEXT NOT NULL,
  detail JSONB,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- How many times it has been re-raised. A number climbing while resolved_at
  -- stays NULL is the signal that nobody has acted.
  occurrences INT NOT NULL DEFAULT 1,

  -- When the admin channel was last actually messaged about this. The
  -- re-notify window is enforced against THIS, not against last_seen_at.
  last_notified_at TIMESTAMPTZ,

  -- Stamped automatically when the underlying condition clears, so a recovered
  -- sweep closes its own alert and the open list means "still broken".
  resolved_at TIMESTAMPTZ
);

COMMENT ON TABLE ops_alerts IS
  'FIX 4/5 (065): durable ops alerts, deduped by `key` while unresolved. The LINE push to ADMIN_LINE_USER_ID is the paging half and is rate-limited against last_notified_at; this table is the half that survives and can be listed at /admin/system.';

-- One OPEN alert per key. This is the dedupe, and it is enforced in the
-- database rather than in the raiser: two processes (API watchdog and worker)
-- can raise the same key concurrently, and a read-then-insert would produce two.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_alerts_open_key
  ON ops_alerts (key)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ops_alerts_open
  ON ops_alerts (last_seen_at DESC)
  WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- RLS: deny-all, consistent with 038's backstop. Service role only.
-- ---------------------------------------------------------------------------

ALTER TABLE job_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_alerts     ENABLE ROW LEVEL SECURITY;
