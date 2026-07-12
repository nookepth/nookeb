-- 029_usage_events.sql
-- Product analytics event log — the single source of truth for "who used WHAT,
-- how many times", which the files/storage tables can't answer (a stored file
-- doesn't record whether it came from a normal upload, a scan, a docx convert,
-- or a diary entry, and abandoned funnels leave no file at all).
--
-- Design: ONE append-only table + a handful of read-only aggregate RPCs. Every
-- new question is a new query, never a new table. Writes are fire-and-forget
-- from the API/worker (services/events.service.ts) and MUST never block or
-- break a user flow — a failed insert is swallowed.
--
-- Privacy (CLAUDE.md — user files are private, that's the product's promise):
-- we store an event_type from a FIXED vocabulary and small structured numbers
-- in `metadata` (page counts, byte sizes, mime category). We never store file
-- names, captions, OCR text, or raw message text.
--
-- NOT auto-applied — run in the Supabase SQL editor BEFORE deploying the code
-- that writes/reads it. The event writer fails open (swallows the missing-table
-- error), so deploying the code first only means "no analytics yet", never a
-- broken user flow.

CREATE TABLE IF NOT EXISTS usage_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,  -- null for pre-auth/anon events
  space_id    UUID,                                          -- optional; not FK'd (groups churn)
  event_type  TEXT NOT NULL,                                 -- fixed vocabulary (see events.service.ts)
  source      TEXT NOT NULL DEFAULT 'line',                  -- 'line' | 'web' | 'worker'
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,            -- {pages, bytes, mime, ...} — numbers only
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Feature-adoption / time-series scans filter by (event_type, created_at).
CREATE INDEX IF NOT EXISTS idx_usage_events_type_time
  ON usage_events (event_type, created_at DESC);

-- Per-user rollups (power users, retention) scan by (user_id, created_at).
CREATE INDEX IF NOT EXISTS idx_usage_events_user_time
  ON usage_events (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- RLS backstop (API/worker use the service-role key which bypasses it; the admin
-- routes gate on ADMIN_LINE_USER_IDS). No policy = no direct anon/auth access.
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- Aggregate RPCs (all STABLE / read-only, CREATE OR REPLACE so this file is
-- re-runnable). Daily buckets are in Asia/Bangkok so "today" matches the user's
-- calendar day (the whole product is Thailand-facing).
-- ============================================================================

-- Feature adoption: per event_type, how many DISTINCT users and how many events
-- since p_since. Drives the "which feature is actually used" table.
CREATE OR REPLACE FUNCTION admin_event_summary(p_since TIMESTAMPTZ)
RETURNS TABLE(event_type TEXT, unique_users BIGINT, event_count BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT event_type,
         COUNT(DISTINCT user_id)::BIGINT AS unique_users,
         COUNT(*)::BIGINT               AS event_count
  FROM usage_events
  WHERE created_at >= p_since
  GROUP BY event_type
  ORDER BY event_count DESC;
$$;

-- DAU / WAU / MAU — distinct active users (any event) over 1 / 7 / 30 days.
-- Stickiness = DAU/MAU is computed in JS from these three numbers.
CREATE OR REPLACE FUNCTION admin_active_user_counts()
RETURNS TABLE(dau BIGINT, wau BIGINT, mau BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT
    COUNT(DISTINCT user_id) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day')::BIGINT,
    COUNT(DISTINCT user_id) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::BIGINT,
    COUNT(DISTINCT user_id) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::BIGINT
  FROM usage_events
  WHERE user_id IS NOT NULL;
$$;

-- Daily active users + total events for the last p_days (Bangkok calendar days).
-- Returned oldest→newest so the web can plot it directly.
CREATE OR REPLACE FUNCTION admin_active_users_daily(p_days INT)
RETURNS TABLE(day DATE, active_users BIGINT, events BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT (created_at AT TIME ZONE 'Asia/Bangkok')::date AS day,
         COUNT(DISTINCT user_id)::BIGINT                AS active_users,
         COUNT(*)::BIGINT                               AS events
  FROM usage_events
  WHERE created_at >= NOW() - (p_days || ' days')::interval
  GROUP BY day
  ORDER BY day;
$$;

-- New signups per day (from users.created_at) for the last p_days.
CREATE OR REPLACE FUNCTION admin_new_users_daily(p_days INT)
RETURNS TABLE(day DATE, new_users BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT (created_at AT TIME ZONE 'Asia/Bangkok')::date AS day,
         COUNT(*)::BIGINT                               AS new_users
  FROM users
  WHERE created_at >= NOW() - (p_days || ' days')::interval
  GROUP BY day
  ORDER BY day;
$$;

-- Retention: of users who signed up in a settled cohort window (had at least
-- p_min_age days to come back), how many returned (any event) ≥1 day and ≥7 days
-- after signup. Uses users.created_at as the cohort anchor. Returns one row.
-- Empty/zero until events accrue for a full window after deploy — expected.
CREATE OR REPLACE FUNCTION admin_retention(p_cohort_days INT, p_min_age_days INT)
RETURNS TABLE(cohort_size BIGINT, d1_returned BIGINT, d7_returned BIGINT)
LANGUAGE sql STABLE AS $$
  WITH cohort AS (
    SELECT id, created_at
    FROM users
    WHERE created_at <  NOW() - (p_min_age_days || ' days')::interval
      AND created_at >= NOW() - (p_cohort_days  || ' days')::interval
  )
  SELECT
    COUNT(*)::BIGINT AS cohort_size,
    COUNT(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM usage_events e
      WHERE e.user_id = c.id
        AND e.created_at >= c.created_at + INTERVAL '1 day'
    ))::BIGINT AS d1_returned,
    COUNT(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM usage_events e
      WHERE e.user_id = c.id
        AND e.created_at >= c.created_at + INTERVAL '7 days'
    ))::BIGINT AS d7_returned
  FROM cohort c;
$$;

-- Revenue-signal leaderboard: users ranked by total activity since p_since, with
-- how many times each hit a quota wall (feature_blocked_quota) and used the
-- cost-bearing convert-to-Word feature. This is the "ready to pay / talk to"
-- list. Joins display_name + storage for context.
CREATE OR REPLACE FUNCTION admin_power_users(p_since TIMESTAMPTZ, p_limit INT)
RETURNS TABLE(
  user_id       UUID,
  display_name  TEXT,
  storage_used  BIGINT,
  storage_limit BIGINT,
  total_events  BIGINT,
  quota_blocks  BIGINT,
  docx_converts BIGINT,
  last_active   TIMESTAMPTZ
)
LANGUAGE sql STABLE AS $$
  SELECT
    u.id,
    u.display_name,
    u.storage_used::BIGINT,
    u.storage_limit::BIGINT,
    COUNT(e.*)::BIGINT AS total_events,
    COUNT(*) FILTER (WHERE e.event_type = 'feature_blocked_quota')::BIGINT AS quota_blocks,
    COUNT(*) FILTER (WHERE e.event_type = 'docx_done')::BIGINT             AS docx_converts,
    MAX(e.created_at) AS last_active
  FROM usage_events e
  JOIN users u ON u.id = e.user_id
  WHERE e.created_at >= p_since
  GROUP BY u.id, u.display_name, u.storage_used, u.storage_limit
  ORDER BY total_events DESC
  LIMIT p_limit;
$$;
