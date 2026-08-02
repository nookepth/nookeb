-- 059_admin_audit_and_settings.sql
-- TIER 2 of the admin surface — the tables that make a privileged WRITE
-- possible and accountable.
--
-- Everything the /admin/* surface has done until now was read-only (029, 042,
-- 058 are all aggregates; the single exception was PATCH /admin/users/:id).
-- TIER 2 adds plan overrides, storage overrides, quota resets, session
-- revocation, queue-job retry/remove, reminder cancellation, a global push kill
-- switch and ticket triage. Every one of those is a change an admin makes to
-- SOMEONE ELSE'S account or to the whole product's messaging, so none of them
-- may happen without a row in admin_audit_log.
--
-- APPLY BEFORE THE API/WORKER DEPLOY. Three hard dependencies:
--   * every TIER 2 write calls recordAdminAction(), which INSERTs into
--     admin_audit_log and 500s the request when that insert fails (fail safe —
--     an unaudited privileged write is worse than a failed one);
--   * services/push-flag.service.ts SELECTs system_settings on every push cache
--     miss (that one fails OPEN — a missing table must not silence the product,
--     see the fail-open note in that file);
--   * services/membership.service.ts syncStorageLimit() reads
--     users.storage_limit_override.
--
-- The reverse order (code first) is survivable but degraded: push stays on, and
-- syncStorageLimit's column read is written to fall back to the pre-059 shape.
-- Every TIER 2 write endpoint, however, will 500 until this is applied. That is
-- deliberate: it fails closed on the writes and open on the messaging.
--
-- Safe to re-run: every statement is IF NOT EXISTS / ON CONFLICT guarded.

-- ============================================================================
-- 1. admin_audit_log — append-only record of every privileged admin write.
--
-- Modelled on usage_events (029): append-only, never updated, never deleted by
-- the product. Nothing in the API issues an UPDATE or DELETE against this
-- table, and nothing should — a mutable audit log answers no question the
-- unmutated one does not answer better.
--
-- admin_line_id is the LINE user id from the verified session, NOT users.id:
-- admin membership is the ADMIN_LINE_USER_IDS env allowlist (CLAUDE.md §13) and
-- has no DB column, so the LINE id is the only identifier that is meaningful
-- both here and in the allowlist. It is deliberately NOT a foreign key — an
-- admin's users row could be deleted and the audit trail must survive that.
--
-- before/after are JSONB snapshots of only the fields the action touched, never
-- whole rows: a whole-row snapshot of `users` would copy display names and
-- storage figures into a second table for no investigative gain. Both are
-- nullable because some actions have no meaningful prior state (a queue job
-- retry) and some have no resulting state (a job removal).
--
-- BIGINT IDENTITY rather than a UUID: this table is only ever read in
-- created_at order and never joined from elsewhere, so a monotonic key is the
-- cheaper index and reads in the order events happened.
-- ============================================================================

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_line_id TEXT NOT NULL,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  before        JSONB,
  after         JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "what happened recently" — the only ordering the log is ever read in.
CREATE INDEX IF NOT EXISTS idx_audit_log_time ON admin_audit_log (created_at DESC);
-- "what did THIS admin do" — the accountability query. Composite, admin first,
-- so it serves both the filtered scan and its ordering without a sort.
CREATE INDEX IF NOT EXISTS idx_audit_log_admin ON admin_audit_log (admin_line_id, created_at DESC);

-- Migration 038's deny-all backstop applies to every table in this schema. The
-- API uses the service-role key and bypasses RLS; enabling it here means a
-- leaked anon key still reads nothing. No policy is created, which IS the
-- deny-all.
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 2. system_settings — product-wide runtime switches, one row per key.
--
-- A TABLE rather than an env var because this switch must be flippable from the
-- admin page in seconds, without a Railway redeploy, and must take effect in
-- BOTH processes at once. Env vars are per-service (CLAUDE.md §13) — a
-- TASK_NOTIFICATIONS_ENABLED-shaped flag has to be set twice and restarts both
-- services to take effect, which is exactly the wrong tool when push is
-- misfiring right now.
--
-- value is JSONB, not BOOLEAN, so a later setting can hold a number, a list or
-- an object without another migration. push_enabled stores the JSON literal
-- `true` / `false`.
--
-- SEEDED WITH push_enabled = true. The seeded row is what makes the read path
-- unambiguous: getPushEnabled() treats a MISSING row and a read ERROR
-- identically (both → true, fail open), so seeding it means the common case is
-- a real read of a real value rather than a fallback that happens to agree.
-- ============================================================================

CREATE TABLE IF NOT EXISTS system_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO system_settings (key, value)
  VALUES ('push_enabled', 'true'::jsonb)
  ON CONFLICT (key) DO NOTHING;

ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 3. users.storage_limit_override — the admin's manual locker ceiling.
--
-- NULL (the default, and the only value any existing row gets) means "no
-- override": the limit is whatever lockerLimitBytes(plan, referral_count)
-- computes. A non-NULL value WINS over the computed one.
--
-- This column exists because users.storage_limit is a DERIVED mirror
-- (services/membership.service.ts) that syncStorageLimit() overwrites on every
-- plan change, referral redemption and subscription lapse. Before this column,
-- an admin who raised storage_limit by hand had their change silently reverted
-- the next time any of those fired — the same class of bug migration 024's
-- GREATEST() guard was written for on the referral path. Storing the intent
-- separately and folding it in at COMPUTE time is what makes the override
-- durable:
--
--     storage_limit = COALESCE(storage_limit_override,
--                              lockerLimitBytes(plan, referral_count))
--
-- BIGINT, not INTEGER: 4 GB already overflows a signed 32-bit column, and the
-- premium tier is 60 GB.
--
-- Purely additive and safe in either deploy order — pre-059 code never selects
-- or writes it, and a NULL default changes no existing user's limit.
-- ============================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS storage_limit_override BIGINT DEFAULT NULL;

COMMENT ON COLUMN users.storage_limit_override IS
  'Admin manual locker ceiling in bytes (059). NULL = use lockerLimitBytes(plan, referral_count). Set only by PATCH /admin/users/:id/storage-override; every set is recorded in admin_audit_log.';
