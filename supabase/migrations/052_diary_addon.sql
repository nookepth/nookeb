-- 052: หนูเก็บความทรงจำ — the diary-reminder ADD-ON (standalone, any plan).
--
-- NOT auto-applied. Apply BEFORE the API/worker deploy: routes/diaryAddon.ts and
-- the hourly sweep in jobs/diaryReminder.job.ts both read these tables directly,
-- so new code against the old schema is broken. Old code against the new schema
-- is safe — everything here is new tables only, nothing existing is touched.
--
-- Design notes the code depends on:
--
--  1) THIS IS NOT A PLAN. It is an add-on any tier can hold, so it deliberately
--     does NOT live in `subscriptions` (whose CHECK is plan IN ('pro','premium')
--     and whose expiry job downgrades users.plan). A premium user buying the
--     add-on must not have their plan row rewritten, and a free user holding the
--     add-on must stay free. Separate table, separate lifecycle.
--
--  2) ONE ROW PER USER, FOREVER. UNIQUE(user_id) — not a partial index on
--     status='active' like uq_subscriptions_active_user. A resubscribe therefore
--     REUSES the row (createSubscription upserts) rather than inserting a second
--     one, which means there is no purchase history in this table. That is the
--     spec's explicit shape; if billing ever needs an audit trail, it belongs in
--     a separate ledger table, not by loosening this constraint.
--
--  3) notify_time IS A BARE `TIME`, ALWAYS READ AS BANGKOK WALL CLOCK. Not
--     timetz: a timetz carries a fixed UTC offset, which is meaningless for a
--     recurring daily wall-clock event. Bangkok is UTC+7 with no DST, so the
--     hourly sweep converts NOW() to Bangkok itself and compares hours. There is
--     no per-user timezone column on purpose — the whole product is ICT.
--
--  4) diary_addon_logs IS THE DELIVERY LEDGER AND THE IDEMPOTENCY KEY.
--     UNIQUE(user_id, date) is what stops the hourly sweep from pushing twice
--     in one Bangkok day if a job is retried or the worker restarts mid-run.
--     The sweep INSERTs the log and treats a 23505 as "already handled today".
--     Skips are logged too (skipped = true) so "why did I not get a nudge" is
--     answerable from data rather than from worker stdout.
--
--  5) NO PAYMENT PROVIDER EXISTS. Nothing in this migration takes money.
--     price_thb records what the user WOULD be charged, in whole Baht (49/365),
--     so the row is already correct on the day a payment callback is wired up.

-- ---------------------------------------------------------------------------
-- 1. diary_addon_subscriptions — who holds the add-on.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS diary_addon_subscriptions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'cancelled', 'expired')),
  billing_cycle  TEXT NOT NULL CHECK (billing_cycle IN ('monthly', 'yearly')),
  -- Whole Baht — 49 (monthly) or 365 (yearly). Mirrors DIARY_ADDON_PRICE in
  -- apps/api/src/config/plans.ts, which is the single source of truth; this
  -- column records what was quoted at purchase time so a later price change
  -- does not rewrite history.
  price_thb      INTEGER NOT NULL CHECK (price_thb >= 0),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Paid access ends here. A CANCELLED row keeps sending until this instant is
  -- passed — cancelling is "do not renew", not "cut me off now" — which is why
  -- isActiveSubscriber() checks status AND expires_at, never one alone.
  expires_at     TIMESTAMPTZ NOT NULL,
  cancelled_at   TIMESTAMPTZ,
  -- Bangkok wall clock. Default 20:00 = the evening, when there is a day worth
  -- writing about (same reasoning as the plan-based sweep's 20:00 cron).
  notify_time    TIME NOT NULL DEFAULT '20:00:00',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_diary_addon_user UNIQUE (user_id)
);

-- The sweep's driving query: WHERE status = 'active' AND expires_at > NOW().
CREATE INDEX IF NOT EXISTS idx_diary_addon_user_status
  ON diary_addon_subscriptions(user_id, status);

-- ---------------------------------------------------------------------------
-- 2. diary_addon_logs — one row per user per Bangkok day, sent OR skipped.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS diary_addon_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  skipped      BOOLEAN NOT NULL DEFAULT FALSE,
  -- Free text rather than an enum CHECK: this is a diagnostic breadcrumb, and a
  -- new skip reason must never be able to fail the INSERT that is also the
  -- day's idempotency guard. The values the code writes today are
  -- 'already_wrote', 'expired' and 'cancelled'.
  skip_reason  TEXT,
  -- The Bangkok calendar day this reminder was FOR — a DATE, not a timestamp,
  -- for exactly the reason user_quotas.period_start is a DATE (migration 051
  -- note 4): it makes "one per day, Thai time" unambiguous on any server TZ.
  date         DATE NOT NULL,
  CONSTRAINT uq_diary_addon_log_user_date UNIQUE (user_id, date)
);

-- Ops query: "how many nudges went out / were skipped on day X".
CREATE INDEX IF NOT EXISTS idx_diary_addon_logs_date_skipped
  ON diary_addon_logs(date, skipped);

-- ---------------------------------------------------------------------------
-- 3. RLS — deny-all backstop, matching migration 038.
--
-- DELIBERATE DEVIATION from "users can only read/write their own rows": this
-- app never issues Supabase Auth sessions, so auth.uid() cannot be mapped to a
-- users.id here (see the header of 038_rls_backstop.sql). A policy written
-- against auth.uid() would match NOTHING and read as protection that does not
-- exist. Enabling RLS with NO policies is the same deny-all these tables need:
-- the anon/authenticated PostgREST roles get nothing, and the API and worker
-- use the SERVICE ROLE key, which bypasses RLS. Per-user isolation is enforced
-- in code (every route filters on request.authUser.userId), which is project
-- rule 4.
-- ---------------------------------------------------------------------------

ALTER TABLE diary_addon_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE diary_addon_logs          ENABLE ROW LEVEL SECURITY;
