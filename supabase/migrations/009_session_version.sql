-- 009_session_version.sql — lightweight JWT revocation.
--
-- Each app JWT embeds the user's session_version at sign time; the auth
-- middleware compares it (via a 60s Redis cache) against this column on every
-- request. Bumping the version therefore invalidates every outstanding token
-- for that user within ~60 seconds — used when a user is removed from a team.
--
-- NOT auto-applied; MUST be applied (supabase db push / SQL editor) BEFORE
-- deploying code that selects users.session_version, or all authenticated
-- requests will fail.

ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1;

-- Atomic increment — same pattern as increment_storage_used (migration 003):
-- callers must never read-modify-write this column.
CREATE OR REPLACE FUNCTION increment_session_version(p_user_id UUID)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE users
  SET session_version = session_version + 1,
      updated_at = NOW()
  WHERE id = p_user_id;
$$;
