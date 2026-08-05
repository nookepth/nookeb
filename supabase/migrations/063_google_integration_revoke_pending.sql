-- 063: google_integrations revoke-pending columns — FIX 1 (manual disconnect
-- did not revoke the grant at Google).
--
-- NOT auto-applied. ORDER-INDEPENDENT vs the deploy in BOTH directions:
--   old DB + new code → services/google-sheets.service.ts catches PostgREST's
--                       undefined-column error (42703 / PGRST204) on every read
--                       and write of these columns and degrades to the PREVIOUS
--                       behaviour (delete the row outright). That is the same
--                       fail-soft shape migration 062 uses, and it is chosen:
--                       an unapplied migration must not make disconnect fail.
--   new DB + old code → the columns are simply never written, and every row
--                       keeps revoke_pending_at NULL, which is "nothing
--                       outstanding".
-- Safe to re-run.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS BROKEN
-- ---------------------------------------------------------------------------
--
-- DELETE /integrations/google called deleteIntegration() directly. The encrypted
-- refresh token is the ONLY copy of that credential, so deleting the row
-- destroyed our ability to ever revoke the grant — while the grant itself
-- stayed alive at Google forever. The automatic trial-expiry sweep already got
-- this right (revoke first, delete second, defer on a transient failure); the
-- manual path did not.
--
-- Making the manual path revoke first introduces a case the sweep does not
-- have: the user is WAITING on an HTTP response. When Google is unreachable we
-- must neither
--   (a) delete anyway  — that is the leak we are fixing, nor
--   (b) tell the user it worked and silently do nothing — that is worse, because
--       they now believe the connection is gone.
--
-- So a transient failure PARKS the row: the credential survives (it is the only
-- thing that can revoke the grant), the user is told the disconnect is still in
-- progress, and the 15-minute sweep retries it to completion.
--
-- ---------------------------------------------------------------------------
-- THE THREE COLUMNS
-- ---------------------------------------------------------------------------
--
--  revoke_pending_at   NON-NULL = "the user asked to disconnect, the grant is
--                      not revoked yet". This is BOTH the retry queue and the
--                      user-visible disconnect: getIntegration() filters these
--                      rows out, so every reader — the dashboard card, both
--                      sheetsWorker sync paths — sees the account as
--                      disconnected the instant the request returns. Only the
--                      retry pass queries the table without that filter.
--
--                      Reconnecting CLEARS it (saveIntegration upserts NULL), so
--                      a user who changes their mind is not left parked.
--
--  revoke_attempts     how many times the retry has tried. Recorded so a grant
--                      that can never be revoked is visible in
--                      /admin/sheets-trial rather than retried in silence
--                      forever.
--
--  revoke_last_error   short, non-secret reason string from the last attempt.
--                      NEVER the token or the request body — see the logging
--                      rule on revokeRefreshToken().

ALTER TABLE google_integrations ADD COLUMN IF NOT EXISTS revoke_pending_at TIMESTAMPTZ;
ALTER TABLE google_integrations ADD COLUMN IF NOT EXISTS revoke_attempts   INT NOT NULL DEFAULT 0;
ALTER TABLE google_integrations ADD COLUMN IF NOT EXISTS revoke_last_error TEXT;

COMMENT ON COLUMN google_integrations.revoke_pending_at IS
  'FIX 1 (063): user requested disconnect but the Google revoke has not succeeded yet. Non-NULL rows are hidden from getIntegration() (so the user IS disconnected) and retried by the 15-minute sweep.';
COMMENT ON COLUMN google_integrations.revoke_attempts IS
  'FIX 1 (063): retry counter for the parked revoke. Surfaced at /admin/sheets-trial so a permanently stuck grant is visible.';
COMMENT ON COLUMN google_integrations.revoke_last_error IS
  'FIX 1 (063): short non-secret failure reason from the last revoke attempt. Never contains a token.';

-- ---------------------------------------------------------------------------
-- The retry index
--
-- Exactly the retry pass's predicate. Partial, so it holds only the rows
-- actually parked at this moment — which is normally zero — and never grows
-- with the table.
--
-- Plain CREATE INDEX, not CONCURRENTLY, for the same reason migration 062 gives:
-- this table is one row per connected user, the lock is milliseconds at that
-- size, and CONCURRENTLY cannot run inside a transaction block, which would
-- make this file un-pasteable as one statement in the Supabase SQL editor.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_google_integrations_revoke_pending
  ON google_integrations (revoke_pending_at)
  WHERE revoke_pending_at IS NOT NULL;
