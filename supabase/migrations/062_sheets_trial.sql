-- 062: หนูเก็บลองงาน — the 14-day Google Sheets TRIAL add-on.
--
-- NOT auto-applied. ORDER-INDEPENDENT vs the deploy, in BOTH directions, and
-- that is deliberate rather than lucky:
--   old DB + new code → services/sheets-trial.service.ts catches PostgREST's
--                       undefined-column error (42703) and reports "no trial",
--                       which is the FAIL-CLOSED direction: nobody is granted
--                       an entitlement, activation answers a typed 503, and
--                       every plan gate keeps behaving exactly as it does now.
--   new DB + old code → the columns are simply never read.
-- The feature is inert until this is applied; nothing else changes.
-- Safe to re-run.
--
-- ---------------------------------------------------------------------------
-- WHY THESE COLUMNS ARE ON `users` AND NOT ON `spaces`
-- ---------------------------------------------------------------------------
--
-- The original spec put the trial on `spaces`. It cannot live there. The synced
-- spreadsheet is "หนูเก็บ — งานของฉัน": it is built from listTasksForUser
-- (tasks the user CREATED or is assigned to, across every group they are in)
-- and every existing entitlement check in the sync path resolves the TASK
-- CREATOR's `users.plan` — see planAllows() in workers/sheetsWorker.ts. No space
-- id is available at any point in that path.
--
-- A user also belongs to one personal space PLUS one space per LINE group, so
-- "the space's trial" has no single answer for "may this user sync". Scoping
-- the trial per-space would mean inventing a space→user mapping that the rest
-- of the feature does not have and does not want.
--
-- Per-user also matches the only comparable thing already in the codebase: the
-- หนูเก็บความทรงจำ add-on (migration 052) is per-user, one row forever.
--
-- ---------------------------------------------------------------------------
-- WHY THERE IS NO `google_sheets_tokens` TABLE
-- ---------------------------------------------------------------------------
--
-- The spec asked for a new per-space token table holding `access_token` and
-- `refresh_token` as plaintext TEXT. That is precisely migration 002
-- (`google_accounts`), which stored a plaintext Google refresh token and was
-- DROPPED BY MIGRATION 017 for exactly that reason — a third-party credential
-- leaks permanently if the database does. Migration 046 replaced it with
-- `google_integrations`, where the refresh token is AES-256-GCM encrypted under
-- a VAULT_MASTER_KEY-derived per-user key.
--
-- The trial therefore stores NO tokens of its own. It reuses
-- `google_integrations` verbatim — one OAuth flow, one token store, one revoke
-- path. Two token stores would mean two revoke paths, and the one that gets
-- forgotten is the leak this whole design is trying to avoid.
--
-- No access token is stored anywhere, by either path: googleapis mints one from
-- the refresh token per call (see authorizedClient), which is one less secret at
-- rest and makes a revoked grant fail loudly instead of after a stale cache.
--
-- ---------------------------------------------------------------------------
-- THE THREE COLUMNS
-- ---------------------------------------------------------------------------
--
--  activated_at  when the user opted in. NON-NULL IS THE ONE-SHOT MARKER: the
--                trial may be started once per user, ever, with no reset and no
--                extension (spec). Activation is a CONDITIONAL UPDATE on
--                `activated_at IS NULL`, so two concurrent taps cannot both win
--                and a second attempt is a 409 rather than a fresh 14 days.
--
--  expires_at    activated_at + 14 days. THE AUTHORITATIVE CUTOFF IS THIS
--                COLUMN COMPARED AT REQUEST TIME, not the sweep — that is what
--                makes "exactly 14 days, no grace period" true. A cron can only
--                ever be as exact as its period; a request-time comparison is
--                exact to the millisecond, and it is re-checked server-side on
--                EVERY Sheets call rather than once at page load.
--
--  revoked_at    the sweep's CLAIM, stamped after the Google grant has actually
--                been revoked and the credential row deleted. It is NOT the
--                expiry (that is expires_at) and it is not user-visible state —
--                it exists so the sweep's driving query is
--                `expires_at <= NOW() AND revoked_at IS NULL`, i.e. "not yet
--                cleaned up", with NO time window.
--
--                The spec's query was windowed:
--                  expires_at <= NOW() AND expires_at > NOW() - INTERVAL '15 min'
--                One missed run — a worker restart, a deploy, a Redis blip, a
--                job that failed all its attempts — and that user's grant falls
--                out of the window PERMANENTLY and their tokens live forever.
--                A claim column makes the sweep self-healing instead: it catches
--                up on everything outstanding on its next successful run,
--                however long that takes.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN IF NOT EXISTS sheets_trial_activated_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sheets_trial_expires_at   TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sheets_trial_revoked_at   TIMESTAMPTZ;

COMMENT ON COLUMN users.sheets_trial_activated_at IS
  'หนูเก็บลองงาน (062): when the 14-day Sheets trial was started. NON-NULL = already used, once per user forever.';
COMMENT ON COLUMN users.sheets_trial_expires_at IS
  'หนูเก็บลองงาน (062): activated_at + 14 days. The authoritative cutoff, compared at request time on every Sheets call.';
COMMENT ON COLUMN users.sheets_trial_revoked_at IS
  'หนูเก็บลองงาน (062): stamped by the expiry sweep AFTER the Google grant was revoked and google_integrations deleted. The sweep''s claim, not the expiry.';

-- ---------------------------------------------------------------------------
-- 2. Integrity
--
-- The three stamps are meaningless apart: an expiry with no activation is an
-- unbounded entitlement, and a revocation with no activation is a cleanup of
-- something that never happened. Postgres has no ADD CONSTRAINT IF NOT EXISTS,
-- hence the guard block — this file must stay re-runnable.
--
-- Every existing row has all three NULL, so the validation scan passes trivially
-- and takes no meaningful lock time.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_sheets_trial_coherent'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_sheets_trial_coherent CHECK (
      -- activation and expiry are set together or not at all
      (sheets_trial_activated_at IS NULL) = (sheets_trial_expires_at IS NULL)
      -- and nothing can be revoked that was never activated
      AND (sheets_trial_revoked_at IS NULL OR sheets_trial_activated_at IS NOT NULL)
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. The sweep index
--
-- Exactly the sweep's predicate: expired but not yet cleaned up. The partial
-- WHERE keeps it to the handful of rows actually outstanding at any moment —
-- every user who never started a trial, and every trial already revoked, is out
-- of the index entirely, so it stays a few pages forever.
--
-- Plain CREATE INDEX, not CONCURRENTLY (unlike migration 048): `users` is one
-- row per human, the brief ACCESS EXCLUSIVE lock is milliseconds at this size,
-- and CONCURRENTLY cannot run inside a transaction block — which would make
-- this file un-runnable as a single paste in the Supabase SQL editor, alongside
-- the ALTER TABLEs above.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_users_sheets_trial_sweep
  ON users (sheets_trial_expires_at)
  WHERE sheets_trial_expires_at IS NOT NULL AND sheets_trial_revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. RLS
--
-- Nothing to do, and that is the correct outcome rather than an omission.
--
-- The spec asked for "users can only read/write their own space's token row".
-- This app never issues Supabase Auth sessions, so `auth.uid()` is always NULL
-- here and a policy written against it would match NOTHING while reading as
-- protection that does not exist — the reasoning is spelled out at length in
-- 038_rls_backstop.sql and repeated in 052. `users` already has RLS enabled
-- with no policies (deny-all) from 038, and `google_integrations` from 046.
-- The API and worker hold the SERVICE ROLE key, which bypasses RLS; per-user
-- isolation is enforced in code — every route in this feature filters on
-- request.authUser.userId and never accepts a user id from the client. That is
-- project rule 4.
-- ---------------------------------------------------------------------------
