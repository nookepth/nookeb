-- 064: google_grant_orphans — FIX 2 (a decrypt failure was reported as a
-- successful revoke).
--
-- NOT auto-applied. ORDER-INDEPENDENT vs the deploy in BOTH directions:
--   old DB + new code → recordOrphanedGrant() returns false when the table is
--                       missing, and EVERY caller treats that as "do not
--                       proceed": the credential row is left alone and retried
--                       next run. That is the fail-CLOSED direction and it is
--                       the point of the whole fix — see below.
--   new DB + old code → the table is simply never written.
-- Safe to re-run.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS BROKEN
-- ---------------------------------------------------------------------------
--
-- revokeRefreshToken() returned `true` when decryptSecret() threw:
--
--     } catch (err) {
--       console.error('could not decrypt stored token for revoke:', ...);
--       return true;      // <-- reported to the caller as "the grant is gone"
--     }
--
-- `true` is the value the sweep reads as "Google has confirmed the grant is
-- revoked, it is now safe to destroy the credential". So the sweep deleted the
-- row. But nothing was ever sent to Google: the grant stayed live, and the only
-- copy of the token that could have revoked it was just deleted. Silently, at
-- INFO-adjacent volume, in a loop over every affected user.
--
-- The trigger is not exotic. Rotating VAULT_MASTER_KEY makes every stored token
-- undecryptable at once — so the FIRST sweep after a key rotation would quietly
-- orphan every outstanding Google grant in the product, and leave no record of
-- which ones. There is no way to enumerate them afterwards: Google will not
-- tell us, and our own rows are gone.
--
-- ---------------------------------------------------------------------------
-- WHY A TABLE AND NOT JUST A LOG LINE
-- ---------------------------------------------------------------------------
--
-- Because the recovery action is manual and per-user: someone has to ask each
-- affected user to remove the app from their Google account page, since we can
-- no longer do it for them. That needs a durable, queryable list with a
-- resolution state — not a line in a log that rotates.
--
-- It also has to be written BEFORE the credential row is deleted, and the
-- delete must not happen if the write failed. This table therefore REPLACES the
-- token as the trail: the row can only be destroyed once something durable
-- records that it existed and could not be revoked.
--
-- Not admin_audit_log (059): that table's `admin_line_id` is the acting admin
-- from a session, and these rows are written by a background sweep with no
-- admin in sight. Overloading it would put un-actioned incidents in the same
-- stream as deliberate admin actions.

CREATE TABLE IF NOT EXISTS google_grant_orphans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Deliberately NOT an FK to users, for the same reason admin_audit_log's
  -- admin_line_id is not one: the whole value of this row is that it OUTLIVES
  -- whatever happens to the account. An orphaned grant does not stop being live
  -- at Google because the user was deleted here.
  user_id UUID NOT NULL,

  -- The Google account the grant belongs to, copied off the credential row
  -- before it is destroyed. Nullable — google_email is cosmetic and may be NULL
  -- on the source row — but it is the single most useful field for the person
  -- doing the manual cleanup, because it names the account to go and look at.
  google_email TEXT,

  -- Why it could not be revoked. Today always 'decrypt_failed'; kept open as
  -- TEXT so a future unrevocable case does not need a migration.
  reason TEXT NOT NULL,

  -- Which path found it: 'trial_sweep' | 'manual_disconnect' | 'pending_retry'
  -- | 'admin_force_expire'. Same vocabulary as RevokeContext in the service.
  context TEXT NOT NULL,

  -- Short, non-secret detail from the failure. NEVER a token.
  detail TEXT,

  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Stamped by hand once a human has confirmed the grant is gone at Google.
  -- NULL = still outstanding, which is what the alert counts.
  resolved_at TIMESTAMPTZ,
  resolved_note TEXT
);

COMMENT ON TABLE google_grant_orphans IS
  'FIX 2 (064): Google OAuth grants we can no longer revoke (the stored refresh token would not decrypt — typically a VAULT_MASTER_KEY rotation). Written BEFORE the credential row is deleted; the delete is skipped if this write fails. Each open row needs a human to have the user remove the app at myaccount.google.com.';

-- One open row per user per reason. A sweep that keeps finding the same
-- undecryptable credential must not produce a new row every 15 minutes — the
-- count is meant to be "how many grants are outstanding", and duplicates would
-- turn a single incident into a rising number that looks like a spreading one.
--
-- Partial on resolved_at IS NULL so a resolved case can legitimately recur
-- (the user reconnected and the key was rotated again).
CREATE UNIQUE INDEX IF NOT EXISTS idx_google_grant_orphans_open
  ON google_grant_orphans (user_id, reason)
  WHERE resolved_at IS NULL;

-- The alert/admin query: everything still outstanding, newest first.
CREATE INDEX IF NOT EXISTS idx_google_grant_orphans_unresolved
  ON google_grant_orphans (detected_at DESC)
  WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- RLS: deny-all, consistent with 038's backstop. Nothing but the service role
-- (API + worker) ever reads this, and the admin surface goes through the API.
-- ---------------------------------------------------------------------------

ALTER TABLE google_grant_orphans ENABLE ROW LEVEL SECURITY;
