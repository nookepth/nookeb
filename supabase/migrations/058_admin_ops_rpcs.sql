-- 058_admin_ops_rpcs.sql
-- Admin OPS aggregates for the /admin/system page (phase 4). Three read-only
-- functions over tables that already exist — NOTHING is created, altered or
-- dropped here, so this migration is order-independent vs the API deploy and
-- safe to re-run (CREATE OR REPLACE throughout).
--
-- NOT auto-applied — run in the Supabase SQL editor. Every /admin/system
-- endpoint fails soft to empty/zero when an RPC is missing, so deploying the
-- code first only means "those cards stay blank until this is applied", never
-- a broken page. Same posture as migrations 029 and 042.
--
-- Daily buckets are Asia/Bangkok, matching 029/042: "day" must mean the user's
-- calendar day, and this product is Thailand-facing.
--
-- Why these three and not more: an aggregate belongs in an RPC only when a
-- PostgREST select would page 1000 rows to compute one number (COUNT/SUM over
-- whole tables, or a GROUP BY over a date spine). The rest of the /admin/system
-- payloads are bounded row reads and stay as supabase.from() chains in
-- routes/admin-ops.ts, where they are easier to read and change.

-- ============================================================================
-- 1. admin_storage_totals() — the storage ledger cards.
--
-- One row, fourteen counters. Every number here is a COUNT/SUM over the whole
-- files / vault_files / users tables, which is exactly the case PostgREST's
-- 1000-row cap would silently undercount (the same reason 026 exists).
--
-- The three file lifecycle states are DISJOINT and each has its own pair, so
-- the cards can never double-count a row:
--   live    = deleted_at IS NULL AND purged_at IS NULL  (in the locker)
--   trashed = deleted_at IS NOT NULL AND purged_at IS NULL  (in ถังขยะ, bytes
--             still on R2 and still charged to the owner's ledger)
--   purged  = purged_at IS NOT NULL  (tombstone; R2 object is gone, so it has
--             no bytes column worth summing — count only)
--
-- vault_files is counted separately, never folded into the file totals: vault
-- bytes are PLAINTEXT bytes (the R2 object is +16 for the GCM tag) and vault
-- rows HARD-delete at purge, so the two tables do not share a lifecycle.
-- ============================================================================

CREATE OR REPLACE FUNCTION admin_storage_totals()
RETURNS TABLE(
  live_files        BIGINT,
  live_bytes        BIGINT,
  trashed_files     BIGINT,
  trashed_bytes     BIGINT,
  purged_files      BIGINT,
  processing_files  BIGINT,
  error_files       BIGINT,
  vault_live_files  BIGINT,
  vault_live_bytes  BIGINT,
  users_total       BIGINT,
  users_over_80     BIGINT,
  users_over_limit  BIGINT,
  storage_used_sum  BIGINT,
  storage_limit_sum BIGINT
)
LANGUAGE sql STABLE AS $$
  SELECT
    (SELECT COUNT(*)::BIGINT
       FROM files WHERE deleted_at IS NULL AND purged_at IS NULL),
    (SELECT COALESCE(SUM(file_size), 0)::BIGINT
       FROM files WHERE deleted_at IS NULL AND purged_at IS NULL),
    (SELECT COUNT(*)::BIGINT
       FROM files WHERE deleted_at IS NOT NULL AND purged_at IS NULL),
    (SELECT COALESCE(SUM(file_size), 0)::BIGINT
       FROM files WHERE deleted_at IS NOT NULL AND purged_at IS NULL),
    (SELECT COUNT(*)::BIGINT
       FROM files WHERE purged_at IS NOT NULL),
    -- Health signals, not ledger lines: a file stuck in 'processing' means a
    -- worker died mid-job, and 'error' means it gave up. Both exclude purged
    -- rows so an old tombstone can't keep an alert lit forever.
    (SELECT COUNT(*)::BIGINT
       FROM files WHERE status = 'processing' AND purged_at IS NULL),
    (SELECT COUNT(*)::BIGINT
       FROM files WHERE status = 'error' AND purged_at IS NULL),
    (SELECT COUNT(*)::BIGINT
       FROM vault_files WHERE deleted_at IS NULL),
    (SELECT COALESCE(SUM(file_size), 0)::BIGINT
       FROM vault_files WHERE deleted_at IS NULL),
    (SELECT COUNT(*)::BIGINT FROM users),
    -- storage_limit > 0 guards the division: a 0-limit row is not "infinitely
    -- full", it is a row whose limit was never set, and it must not be counted
    -- as pressure.
    (SELECT COUNT(*)::BIGINT
       FROM users
      WHERE storage_limit > 0
        AND storage_used >= (storage_limit::NUMERIC * 0.8)
        AND storage_used < storage_limit),
    (SELECT COUNT(*)::BIGINT
       FROM users WHERE storage_limit > 0 AND storage_used >= storage_limit),
    (SELECT COALESCE(SUM(storage_used), 0)::BIGINT FROM users),
    (SELECT COALESCE(SUM(storage_limit), 0)::BIGINT FROM users);
$$;

COMMENT ON FUNCTION admin_storage_totals() IS
  'Admin ops (058): whole-table storage ledger + fill-pressure counters. One row.';

-- ============================================================================
-- 2. admin_reminder_outcomes_daily(p_days) — task-reminder delivery outcomes.
--
-- Bucketed by remind_at (WHEN THE SHOT WAS DUE), not by sent_at/failed_at/
-- cancelled_at. Those are three different columns and only one is ever set per
-- row, so bucketing "the outcome timestamp" would need a COALESCE across three
-- columns and would put a retry's outcome on a different day from the shot it
-- belongs to. remind_at is the one timestamp every row has, which makes each
-- day's four numbers add up to that day's scheduled total — the property that
-- lets the stacked bar chart be read as a whole.
--
-- So: "of the reminders DUE on day X, how many sent / failed / were cancelled /
-- are still outstanding". `pending` on a past day is the interesting one — it
-- means the worker never picked the shot up.
--
-- task_reminders rows are stamped, never deleted (CLAUDE.md §8), so this is a
-- complete history for as far back as p_days reaches.
-- ============================================================================

CREATE OR REPLACE FUNCTION admin_reminder_outcomes_daily(p_days INT)
RETURNS TABLE(
  day       DATE,
  scheduled BIGINT,
  sent      BIGINT,
  failed    BIGINT,
  cancelled BIGINT,
  pending   BIGINT
)
LANGUAGE sql STABLE AS $$
  SELECT
    (r.remind_at AT TIME ZONE 'Asia/Bangkok')::date AS day,
    COUNT(*)::BIGINT,
    COUNT(*) FILTER (WHERE r.sent_at IS NOT NULL)::BIGINT,
    COUNT(*) FILTER (WHERE r.failed_at IS NOT NULL)::BIGINT,
    COUNT(*) FILTER (WHERE r.cancelled_at IS NOT NULL)::BIGINT,
    COUNT(*) FILTER (
      WHERE r.sent_at IS NULL AND r.failed_at IS NULL AND r.cancelled_at IS NULL
    )::BIGINT
  FROM task_reminders AS r
  WHERE r.remind_at >= NOW() - (p_days || ' days')::interval
  GROUP BY 1
  ORDER BY 1;
$$;

COMMENT ON FUNCTION admin_reminder_outcomes_daily(INT) IS
  'Admin ops (058): task_reminders outcomes per Bangkok day, bucketed by remind_at (due date).';

-- ============================================================================
-- 3. admin_diary_addon_daily(p_days) — หนูเก็บความทรงจำ nudge delivery.
--
-- diary_addon_logs.date is ALREADY a Bangkok calendar DATE (migration 052), so
-- this one does NOT convert a timestamp — doing so would shift the bucket by
-- the offset a second time. That column is also the sweep's per-day idempotency
-- key, so one row per user per day is guaranteed and these counts are exact.
--
-- `skipped` is not a failure: it is the sweep correctly declining to nudge
-- someone who already wrote today (skip_reason 'already_wrote'), or whose
-- add-on lapsed ('expired' / 'cancelled'). Broken out so the two are never
-- read as one number.
--
-- EVERY column reference below is table-qualified, and that is load-bearing,
-- not house style. `RETURNS TABLE(...)` declares OUT PARAMETERS, and an OUT
-- parameter name that collides with a real column of a table in the FROM clause
-- makes a bare reference ambiguous — Postgres raises
-- `column reference "skipped" is ambiguous` on EVERY call. Here the OUT param
-- `skipped` collides head-on with `diary_addon_logs.skipped`, so an unqualified
-- body would fail 100% of the time at runtime while looking perfectly correct.
-- (Migration 051 shipped the PL/pgSQL flavour of this same bug twice.) The
-- other two functions in this file have no such collision, but qualifying costs
-- nothing and removes the need to re-check when a column is added later.
-- ============================================================================

CREATE OR REPLACE FUNCTION admin_diary_addon_daily(p_days INT)
RETURNS TABLE(
  day            DATE,
  sent           BIGINT,
  skipped        BIGINT,
  skipped_wrote  BIGINT,
  skipped_lapsed BIGINT
)
LANGUAGE sql STABLE AS $$
  SELECT
    l.date AS day,
    COUNT(*) FILTER (WHERE l.skipped = FALSE)::BIGINT,
    COUNT(*) FILTER (WHERE l.skipped = TRUE)::BIGINT,
    COUNT(*) FILTER (WHERE l.skipped = TRUE AND l.skip_reason = 'already_wrote')::BIGINT,
    COUNT(*) FILTER (WHERE l.skipped = TRUE AND l.skip_reason IN ('expired', 'cancelled'))::BIGINT
  FROM diary_addon_logs AS l
  WHERE l.date >= (NOW() AT TIME ZONE 'Asia/Bangkok')::date - p_days
  GROUP BY 1
  ORDER BY 1;
$$;

COMMENT ON FUNCTION admin_diary_addon_daily(INT) IS
  'Admin ops (058): diary add-on nudges sent vs skipped per Bangkok day (migration 052 logs).';
