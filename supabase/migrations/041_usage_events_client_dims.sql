-- 041_usage_events_client_dims.sql
-- Task-2 event-tracking dimensions on the existing usage_events log (migration
-- 029). Three nullable columns carry the client-event schema fields that the
-- original log didn't have. Additive + nullable + no default → every existing
-- row and every existing logEvent() insert stays valid.
--
-- IMPORTANT: there is NO CHECK/enum on event_type (029) and this migration does
-- NOT add one. The event vocabulary stays enforced in code — the EventType union
-- in services/events.service.ts AND the runtime whitelist in the new
-- POST /api/events/track endpoint (the only path a client can write an event).
-- The client never writes usage_events directly; that rule is unchanged.
--
-- NOT auto-applied — run in the Supabase SQL editor BEFORE deploying the code
-- that writes these columns. The event writer fails open, so deploying code
-- first just means the columns stay NULL until this is applied.

ALTER TABLE usage_events
  -- correlates the events of one client session (uuid minted client-side per
  -- app load); NULL for server-originated events that have no browser session.
  ADD COLUMN IF NOT EXISTS session_id    UUID,
  -- 'free' | 'pro' snapshot at event time. CHECK allows NULL (server events /
  -- pre-migration rows) but rejects typos. Only 'free' exists today; 'pro' is
  -- forward-looking (no billing yet) — keep in sync with users.plan values.
  ADD COLUMN IF NOT EXISTS plan_tier     TEXT
    CHECK (plan_tier IS NULL OR plan_tier IN ('free', 'pro')),
  -- optional origin hint ('line' | 'liff' | 'web' | ...); deliberately
  -- unconstrained so a new surface never needs a migration to log itself.
  ADD COLUMN IF NOT EXISTS entry_channel TEXT;

-- Per-session funnel queries (distinct sessions, step ordering within a session).
CREATE INDEX IF NOT EXISTS idx_usage_events_session
  ON usage_events (session_id, created_at)
  WHERE session_id IS NOT NULL;

-- Free-vs-pro segmented metrics on the admin dashboard.
CREATE INDEX IF NOT EXISTS idx_usage_events_plan_time
  ON usage_events (plan_tier, created_at DESC)
  WHERE plan_tier IS NOT NULL;
