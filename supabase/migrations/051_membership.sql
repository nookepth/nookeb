-- 051: ระบบสมาชิก (Membership) — plans, quotas, boosts, subscriptions, support SLA.
--
-- NOT auto-applied. Apply BEFORE the API/worker deploy: every quota-guarded route
-- calls consume_quota() and every plan read normalises against the widened
-- users.plan CHECK. Old code against the new schema is safe (all additions are
-- new tables/columns plus a WIDENED check constraint); new code against the old
-- schema is NOT — consume_quota would not exist.
--
-- Design notes that the rest of the codebase depends on:
--
--  1) PLAN VOCABULARY. 001 shipped CHECK (plan IN ('free','pro','team')). The
--     membership spec is free/pro/premium. 'team' is KEPT in the constraint so
--     existing rows stay valid and no data migration is needed; application code
--     normalises 'team' → 'premium' (config/plans.ts `normalizePlan`). Nothing
--     writes 'team' any more.
--
--  2) QUOTA ATOMICITY. user_quotas is never read-modify-written from the app
--     (project rule 8, the same reason storage_used goes through
--     increment_storage_used). consume_quota() does the check and the increment
--     inside ONE statement holding the row lock, so two concurrent uploads can
--     never both pass the last unit of a quota.
--
--  3) SCOPE. Most quotas are per-user ('' scope). Group file quota is per
--     (user, group, month), which is expressed as scope_id = the LINE group id
--     rather than a second table — one engine, one reset job, one shape.
--     scope_id is NOT NULL DEFAULT '' on purpose: a NULL would defeat the
--     UNIQUE constraint (NULLs are distinct in Postgres < 15 semantics), which
--     is exactly the bug that would let a user hold unlimited duplicate rows.
--
--  4) PERIOD. period_start is a DATE holding the Bangkok (UTC+7) month start.
--     Storing the Bangkok calendar date — not a timestamptz — is what makes
--     "resets on the 1st at 00:00 ICT" unambiguous regardless of server TZ.

-- ---------------------------------------------------------------------------
-- 1. Plan vocabulary
-- ---------------------------------------------------------------------------

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check;
ALTER TABLE users
  ADD CONSTRAINT users_plan_check CHECK (plan IN ('free', 'pro', 'premium', 'team'));

-- ---------------------------------------------------------------------------
-- 2. subscriptions — what the user is paying for.
--
-- NO payment provider is wired up (see the gap report): this table records
-- subscription STATE so plan resolution, proration-free upgrades and the
-- renewal job have something authoritative to read. price_thb is whole Baht —
-- every price in the matrix (59 / 599 / 129 / 1290) is an integer, so there is
-- no satang rounding to get wrong.
-- ---------------------------------------------------------------------------

CREATE TABLE subscriptions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan                TEXT NOT NULL CHECK (plan IN ('pro', 'premium')),
  billing_cycle       TEXT NOT NULL CHECK (billing_cycle IN ('monthly', 'yearly')),
  price_thb           INTEGER NOT NULL CHECK (price_thb >= 0),
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'cancelled', 'expired')),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- When the paid access ends. A cancelled subscription keeps its plan until
  -- this instant, then the expiry job downgrades the user to free.
  current_period_end  TIMESTAMPTZ NOT NULL,
  cancelled_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- At most ONE active subscription per user — an upgrade cancels the old row
-- first. Partial index so cancelled/expired history is unconstrained.
CREATE UNIQUE INDEX uq_subscriptions_active_user
  ON subscriptions(user_id) WHERE status = 'active';
CREATE INDEX idx_subscriptions_expiry
  ON subscriptions(current_period_end) WHERE status = 'active';

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 3. user_quotas — the monthly counters.
--
-- `limit_value`, not `limit`: LIMIT is a reserved word and would need quoting
-- in every hand-written statement forever.
--
-- The limit is STORED per row (not looked up from the plan at read time) so a
-- quota row is self-describing in the DB and so the reset job can rebuild next
-- month's limits from the then-current plan. It is ALSO re-synced on every
-- consume_quota() call, which is what makes a mid-month upgrade/downgrade take
-- effect immediately without touching `used` (spec: recalculate limit, do not
-- reset usage).
-- ---------------------------------------------------------------------------

CREATE TABLE user_quotas (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- matches a key of MONTHLY_QUOTAS in apps/api/src/config/plans.ts
  feature       TEXT NOT NULL,
  -- '' = user-global. For feature='group_files' this is the LINE group id.
  scope_id      TEXT NOT NULL DEFAULT '',
  -- Bangkok (UTC+7) calendar month start, e.g. 2026-08-01
  period_start  DATE NOT NULL,
  used          INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  -- -1 = unlimited (daily diary reminders on pro/premium, share links, …)
  limit_value   INTEGER NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, feature, scope_id, period_start)
);

-- Required by the spec: the quota lookup index.
CREATE INDEX idx_user_quotas_user_period ON user_quotas(user_id, period_start);
-- Required by the spec verbatim: composite unique for the group-file quota.
-- Redundant with the 4-column UNIQUE above but kept as an explicit, named
-- backstop so the (user, group, month) invariant survives a future refactor of
-- the generic constraint.
CREATE UNIQUE INDEX uq_user_quotas_group_files
  ON user_quotas(user_id, scope_id, period_start) WHERE feature = 'group_files';
-- Reset/cleanup job scans by period.
CREATE INDEX idx_user_quotas_period ON user_quotas(period_start);

ALTER TABLE user_quotas ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 4. consume_quota / release_quota RPCs
--
-- consume_quota is the ONLY sanctioned way to spend a quota unit. It:
--   - creates the period row on first use, stamping the caller's limit;
--   - re-syncs limit_value every call (mid-month plan change);
--   - increments ONLY if it stays within the limit, in the same statement;
--   - returns the post-state plus `allowed` so the caller can build the
--     structured QUOTA_EXCEEDED payload without a second read.
-- p_limit < 0 means unlimited: the row still counts usage (useful for
-- analytics) but never blocks.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION consume_quota(
  p_user_id      UUID,
  p_feature      TEXT,
  p_scope_id     TEXT,
  p_period_start DATE,
  p_limit        INTEGER,
  p_amount       INTEGER
) RETURNS TABLE (used INTEGER, limit_value INTEGER, allowed BOOLEAN)
LANGUAGE plpgsql
AS $$
DECLARE
  v_used  INTEGER;
  v_limit INTEGER;
BEGIN
  -- NOTE ON ALIASES: `used`, `limit_value` and `allowed` are OUT parameters
  -- here (RETURNS TABLE declares them as variables), so a BARE `used` in an
  -- expression is ambiguous with the column of the same name and PL/pgSQL
  -- raises "column reference is ambiguous" at RUNTIME — not at CREATE time.
  -- Every statement below therefore aliases the table and qualifies each
  -- column reference. Do not "simplify" these away.
  IF p_amount < 0 THEN
    RAISE EXCEPTION 'consume_quota: p_amount must be >= 0 (got %)', p_amount;
  END IF;

  -- Ensure the period row exists and carries the CURRENT limit. Doing this as
  -- an upsert (rather than SELECT-then-INSERT) is what makes first use of a
  -- feature race-free between two concurrent requests.
  INSERT INTO user_quotas AS q (user_id, feature, scope_id, period_start, used, limit_value)
  VALUES (p_user_id, p_feature, p_scope_id, p_period_start, 0, p_limit)
  ON CONFLICT (user_id, feature, scope_id, period_start)
  DO UPDATE SET limit_value = EXCLUDED.limit_value,
                updated_at  = NOW()
  WHERE q.limit_value IS DISTINCT FROM EXCLUDED.limit_value;

  -- The guarded increment. The WHERE clause is the enforcement point; the row
  -- lock taken by UPDATE serialises concurrent spenders of the same quota.
  UPDATE user_quotas q
     SET used = q.used + p_amount,
         updated_at = NOW()
   WHERE q.user_id = p_user_id
     AND q.feature = p_feature
     AND q.scope_id = p_scope_id
     AND q.period_start = p_period_start
     AND (p_limit < 0 OR q.used + p_amount <= p_limit)
  RETURNING q.used, q.limit_value INTO v_used, v_limit;

  IF FOUND THEN
    RETURN QUERY SELECT v_used, v_limit, TRUE;
    RETURN;
  END IF;

  -- Over limit: report the unchanged state so the caller can render
  -- { limit, used, reset_at } without another round trip.
  SELECT q2.used, q2.limit_value INTO v_used, v_limit
    FROM user_quotas q2
   WHERE q2.user_id = p_user_id
     AND q2.feature = p_feature
     AND q2.scope_id = p_scope_id
     AND q2.period_start = p_period_start;

  RETURN QUERY SELECT COALESCE(v_used, 0), COALESCE(v_limit, p_limit), FALSE;
END;
$$;

-- Give back units when the action that reserved them did not happen (upload
-- stream failed, worker job errored before producing output). Clamped at 0 so a
-- double release can never mint quota. NEVER call this for a user-initiated
-- delete — the spec is explicit that deleting a task does not refund.
CREATE OR REPLACE FUNCTION release_quota(
  p_user_id      UUID,
  p_feature      TEXT,
  p_scope_id     TEXT,
  p_period_start DATE,
  p_amount       INTEGER
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_used INTEGER;
BEGIN
  UPDATE user_quotas q
     SET used = GREATEST(0, q.used - GREATEST(0, p_amount)),
         updated_at = NOW()
   WHERE q.user_id = p_user_id
     AND q.feature = p_feature
     AND q.scope_id = p_scope_id
     AND q.period_start = p_period_start
  RETURNING q.used INTO v_used;

  RETURN COALESCE(v_used, 0);
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. user_group_boosts — "บูธ"
--
-- A boost is LIVE when released_at IS NULL AND expires_at > NOW(). Un-boosting
-- stamps released_at rather than deleting, so "which groups did I boost last
-- quarter" stays answerable and the partial unique index still allows the same
-- (user, group) pair to be boosted again later.
-- ---------------------------------------------------------------------------

CREATE TABLE user_group_boosts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- LINE group id (C...). Groups are not a first-class table keyed by UUID in
  -- this codebase — the LINE group id IS the tenant key (see CLAUDE.md §8).
  group_id      TEXT NOT NULL,
  activated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  released_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- One LIVE boost per (user, group). Expired-but-unreleased rows still occupy
-- this slot; the daily expiry job stamps released_at, and claim_boost also
-- self-heals by ignoring expired rows when counting.
CREATE UNIQUE INDEX uq_group_boost_live
  ON user_group_boosts(user_id, group_id) WHERE released_at IS NULL;
CREATE INDEX idx_group_boost_user_live
  ON user_group_boosts(user_id) WHERE released_at IS NULL;
CREATE INDEX idx_group_boost_group_live
  ON user_group_boosts(group_id) WHERE released_at IS NULL;
CREATE INDEX idx_group_boost_expiry
  ON user_group_boosts(expires_at) WHERE released_at IS NULL;

ALTER TABLE user_group_boosts ENABLE ROW LEVEL SECURITY;

-- Claim a boost slot atomically. Counting live boosts and inserting in separate
-- statements is racy (two requests both see 0 of 1 used); locking the users row
-- first serialises every boost claim by the same user, which is the only
-- contention that matters here.
--
-- Returns the new row, or no rows when the plan's slots are full.
CREATE OR REPLACE FUNCTION claim_group_boost(
  p_user_id   UUID,
  p_group_id  TEXT,
  p_max       INTEGER,
  p_days      INTEGER
) RETURNS TABLE (id UUID, group_id TEXT, activated_at TIMESTAMPTZ, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE
  v_live INTEGER;
BEGIN
  IF p_max <= 0 THEN
    RETURN;  -- free plan: no slots at all
  END IF;

  PERFORM 1 FROM users WHERE users.id = p_user_id FOR UPDATE;

  SELECT COUNT(*) INTO v_live
    FROM user_group_boosts b
   WHERE b.user_id = p_user_id
     AND b.released_at IS NULL
     AND b.expires_at > NOW();

  -- Re-boosting a group that is already live is a no-op, not a slot spend.
  IF EXISTS (
    SELECT 1 FROM user_group_boosts b
     WHERE b.user_id = p_user_id AND b.group_id = p_group_id
       AND b.released_at IS NULL AND b.expires_at > NOW()
  ) THEN
    RETURN QUERY
      SELECT b.id, b.group_id, b.activated_at, b.expires_at
        FROM user_group_boosts b
       WHERE b.user_id = p_user_id AND b.group_id = p_group_id
         AND b.released_at IS NULL AND b.expires_at > NOW();
    RETURN;
  END IF;

  IF v_live >= p_max THEN
    RETURN;  -- caller turns this into BOOST_LIMIT_REACHED
  END IF;

  -- An expired-but-unreleased row for this same group would trip the partial
  -- unique index, so retire it first (self-heal if the expiry job is behind).
  UPDATE user_group_boosts b
     SET released_at = NOW()
   WHERE b.user_id = p_user_id AND b.group_id = p_group_id AND b.released_at IS NULL;

  -- Wrapped in a CTE rather than `RETURN QUERY INSERT … RETURNING` so the
  -- statement is unambiguously a SELECT, and so every returned column is
  -- qualified (id / group_id / activated_at / expires_at are all OUT parameter
  -- names here — see the alias note in consume_quota).
  RETURN QUERY
  WITH ins AS (
    INSERT INTO user_group_boosts (user_id, group_id, expires_at)
    VALUES (p_user_id, p_group_id, NOW() + make_interval(days => p_days))
    RETURNING user_group_boosts.id,
              user_group_boosts.group_id,
              user_group_boosts.activated_at,
              user_group_boosts.expires_at
  )
  SELECT ins.id, ins.group_id, ins.activated_at, ins.expires_at FROM ins;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. support_tickets — SLA derived from plan AT CREATION TIME.
--
-- sla_hours is stored, not computed on read: the promise made to the user when
-- they opened the ticket must not change because they downgraded afterwards.
-- ---------------------------------------------------------------------------

CREATE TABLE support_tickets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject           TEXT NOT NULL,
  body              TEXT NOT NULL,
  -- snapshot of the plan that set the SLA (audit: why is this ticket 4h?)
  plan_at_creation  TEXT NOT NULL,
  sla_hours         INTEGER NOT NULL CHECK (sla_hours > 0),
  due_at            TIMESTAMPTZ NOT NULL,
  -- premium entitlement: onboarding setup call
  onboarding_call   BOOLEAN NOT NULL DEFAULT FALSE,
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'answered', 'closed')),
  first_response_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_support_tickets_user ON support_tickets(user_id, created_at DESC);
-- Ops queue: what is open and closest to breaching.
CREATE INDEX idx_support_tickets_due ON support_tickets(due_at) WHERE status = 'open';

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 7. user_integrations — third-party connections.
--
-- DELIBERATELY does NOT absorb google_integrations (migration 046). That table
-- already holds live AES-256-GCM encrypted refresh tokens; moving ciphertext
-- between tables is a data-loss risk with no functional payoff, and 046's
-- shape is already this contract for Google. This table is the home for every
-- OTHER provider (LINE diary push opt-in today) and the generic surface the
-- membership layer reads for "is <provider> connected".
--
-- Same rule as 046: encrypted_token is base64(iv || tag || ciphertext) via
-- services/vault-crypto.ts. A plaintext token here is a bug, not a shortcut.
-- ---------------------------------------------------------------------------

CREATE TABLE user_integrations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL CHECK (provider IN ('google_sheets', 'line')),
  -- provider-side identifier (LINE user id, Google account email)
  external_id     TEXT,
  status          TEXT NOT NULL DEFAULT 'connected'
                    CHECK (status IN ('connected', 'revoked', 'error')),
  encrypted_token TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error      TEXT,
  connected_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, provider)
);

CREATE INDEX idx_user_integrations_user ON user_integrations(user_id);

ALTER TABLE user_integrations ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 8. Task reminder configuration (feature matrix §4b / §4c)
--
-- reminder_intervals holds HOURS BEFORE DEADLINE, e.g. [6,24] = "1 day before
-- AND 6h before". Stored as int[] per the spec. NULL = the plan's default
-- behaviour (a single reminder at the deadline).
--
-- The CHECK is the server-side backstop behind the checkbox limit: values must
-- come from the allowed set and there can never be more than 4 of them, no
-- matter what a client posts. The PER-PLAN cap (1/2/4) is enforced in
-- middleware/planGuard.ts because it needs the caller's plan.
-- ---------------------------------------------------------------------------

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS reminder_intervals INTEGER[];

-- "No duplicate checkboxes" needs a DISTINCT count, and a CHECK constraint may
-- not contain a subquery — so it goes through an IMMUTABLE helper, which CHECK
-- does allow. Declared IMMUTABLE because the result depends only on the input
-- array; that is what makes it legal to index/constrain on.
CREATE OR REPLACE FUNCTION nookeb_int_array_is_distinct(a INTEGER[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT cardinality(a) = (SELECT COUNT(DISTINCT x) FROM unnest(a) AS x);
$$;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_reminder_intervals_check CHECK (
    reminder_intervals IS NULL OR (
      reminder_intervals <@ ARRAY[3, 6, 24, 48, 72]
      -- cardinality(), not array_length(): array_length('{}', 1) is NULL, and a
      -- NULL comparison makes a CHECK PASS — an empty array would slip through.
      -- cardinality('{}') is 0, which fails the range as intended.
      AND cardinality(reminder_intervals) BETWEEN 1 AND 4
      AND nookeb_int_array_is_distinct(reminder_intervals)
    )
  );

-- §4c "เตือนเฉพาะคนที่ยังไม่ส่งงาน" — pro/premium only, enforced at write time.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS notify_only_pending BOOLEAN NOT NULL DEFAULT FALSE;

-- The §4b checkbox set (3h/6h/1d/2d/3d) does not fit the four shot types
-- migration 036 allows: '6_hours' and '2_days' have no equivalent. Widen the
-- constraint to match the RemindType union in packages/shared/src/types/task.ts
-- — the two MUST stay in lockstep, or a scheduled reminder fails its insert at
-- midnight.
--
-- There is NO zero-offset shot: a reminder fires only at an interval the
-- creator selected, and selecting nothing schedules nothing.
--
-- Purely additive: every existing value stays valid, so this is safe to apply
-- before or after the code deploy.
ALTER TABLE task_reminders DROP CONSTRAINT IF EXISTS task_reminders_remind_type_check;
ALTER TABLE task_reminders
  ADD CONSTRAINT task_reminders_remind_type_check CHECK (
    remind_type IN ('3_days', '2_days', '1_day', '6_hours', '3_hours', 'overdue')
  );
