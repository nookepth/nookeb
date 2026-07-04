-- 008_team_join_requests.sql — owner/admin approval for invite-link joins
-- NOT auto-applied — run via `supabase db push` or the Supabase SQL editor
-- BEFORE deploying code that uses team_join_requests.
--
-- Changes the invite flow from "anyone with the link joins instantly" to
-- "the link raises a join REQUEST that an owner/admin must approve".

-- 1. Allow 'pending_approval' as a team_invites.status value (the invite row
--    itself stays 'pending' so a single link can gather multiple requests).
ALTER TABLE team_invites DROP CONSTRAINT IF EXISTS team_invites_status_check;
ALTER TABLE team_invites
  ADD CONSTRAINT team_invites_status_check
  CHECK (status IN ('pending', 'accepted', 'expired', 'pending_approval'));

-- 2. Join requests raised via an invite link, awaiting owner/admin review.
CREATE TABLE IF NOT EXISTS team_join_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_id    UUID NOT NULL REFERENCES team_invites(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at  TIMESTAMPTZ DEFAULT NULL
);

-- One open request per (user, team): guards against duplicate pending rows even
-- under a race (the service also checks first). Partial UNIQUE on status='pending'.
CREATE UNIQUE INDEX IF NOT EXISTS uq_team_join_requests_pending
  ON team_join_requests(team_id, user_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_team_join_requests_team   ON team_join_requests(team_id);
CREATE INDEX IF NOT EXISTS idx_team_join_requests_user   ON team_join_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_team_join_requests_status ON team_join_requests(team_id, status);

-- RLS (backstop only — the API uses the service role key which bypasses RLS;
-- membership/role is enforced explicitly in team.service.ts)
ALTER TABLE team_join_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members_see_team_join_requests" ON team_join_requests
  FOR SELECT USING (
    team_id IN (SELECT team_id FROM team_members WHERE user_id = auth.uid())
  );
