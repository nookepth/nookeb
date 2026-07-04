-- 005_teams.sql — first-class teams (replaces the implicit spaces(type='team') model)
-- NOT auto-applied — run via `supabase db push` or the Supabase SQL editor
-- BEFORE deploying code that uses teams / files.team_id / increment_team_storage.
--
-- Design notes:
-- * Existing spaces/space_members stay untouched — files keep their space_id and
--   the old group-space flow keeps working for unbound groups.
-- * Team storage is tracked on teams.storage_used, adjusted ONLY via the atomic
--   increment_team_storage() RPC below (same rule as users.storage_used, rule 8).
-- * users.storage_used / storage_limit are NOT touched.

-- TEAMS
CREATE TABLE IF NOT EXISTS teams (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  owner_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_used  BIGINT NOT NULL DEFAULT 0,
  storage_limit BIGINT NOT NULL DEFAULT 10737418240, -- 10 GB
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ DEFAULT NULL             -- soft delete
);

-- TEAM_MEMBERS
CREATE TABLE IF NOT EXISTS team_members (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id   UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (team_id, user_id)
);

-- TEAM_INVITES (stateful — listable, trackable, expirable; unlike the old JWT links)
CREATE TABLE IF NOT EXISTS team_invites (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  invited_by UUID REFERENCES users(id),
  token      TEXT UNIQUE NOT NULL DEFAULT gen_random_uuid()::text,
  status     TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired')),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- TEAM_LINE_GROUPS (explicit LINE group ↔ team binding; a group binds to ONE team)
CREATE TABLE IF NOT EXISTS team_line_groups (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id       UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  line_group_id TEXT NOT NULL UNIQUE,
  bound_by      UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- files gain an optional team owner (space_id remains the storage/tenant key)
ALTER TABLE files ADD COLUMN IF NOT EXISTS
  team_id UUID REFERENCES teams(id) ON DELETE SET NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_team_members_user_id   ON team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_team_members_team_id   ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_invites_team_id   ON team_invites(team_id);
CREATE INDEX IF NOT EXISTS idx_team_line_groups_team  ON team_line_groups(team_id);
CREATE INDEX IF NOT EXISTS idx_files_team_id          ON files(team_id) WHERE team_id IS NOT NULL;

-- Atomic team storage accounting with quota enforcement.
-- p_enforce = TRUE  → raise 'team_quota_exceeded' if the increment would push
--                     storage_used past storage_limit (used to RESERVE quota
--                     BEFORE storing a file).
-- p_enforce = FALSE → unconditional adjustment, clamped at 0 (used to SETTLE the
--                     declared-vs-actual size difference after upload, and to
--                     free space on delete — must never fail post-store).
CREATE OR REPLACE FUNCTION increment_team_storage(
  p_team_id UUID,
  p_delta   BIGINT,
  p_enforce BOOLEAN DEFAULT TRUE
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  new_used BIGINT;
BEGIN
  IF p_enforce AND p_delta > 0 THEN
    UPDATE teams
       SET storage_used = storage_used + p_delta
     WHERE id = p_team_id
       AND deleted_at IS NULL
       AND storage_used + p_delta <= storage_limit
    RETURNING storage_used INTO new_used;
    IF new_used IS NULL THEN
      RAISE EXCEPTION 'team_quota_exceeded' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    UPDATE teams
       SET storage_used = GREATEST(0, storage_used + p_delta)
     WHERE id = p_team_id
    RETURNING storage_used INTO new_used;
  END IF;
  RETURN new_used;
END;
$$;

-- Row Level Security (backstop only — the API uses the service role key which
-- bypasses RLS; membership is enforced explicitly in team.service.ts)
ALTER TABLE teams            ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_invites     ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_line_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members_see_own_teams" ON teams
  FOR SELECT USING (
    id IN (SELECT team_id FROM team_members WHERE user_id = auth.uid())
  );

CREATE POLICY "members_see_team_members" ON team_members
  FOR SELECT USING (
    team_id IN (SELECT team_id FROM team_members WHERE user_id = auth.uid())
  );

CREATE POLICY "members_see_team_invites" ON team_invites
  FOR SELECT USING (
    team_id IN (SELECT team_id FROM team_members WHERE user_id = auth.uid())
  );

CREATE POLICY "members_see_team_groups" ON team_line_groups
  FOR SELECT USING (
    team_id IN (SELECT team_id FROM team_members WHERE user_id = auth.uid())
  );

-- files: team members can SELECT team files; owners/admins can DELETE them.
-- (Permissive policies OR together with the existing space-membership policy.)
CREATE POLICY "team_members_select_team_files" ON files
  FOR SELECT USING (
    team_id IS NOT NULL
    AND team_id IN (SELECT team_id FROM team_members WHERE user_id = auth.uid())
  );

CREATE POLICY "team_admins_delete_team_files" ON files
  FOR DELETE USING (
    team_id IS NOT NULL
    AND team_id IN (
      SELECT team_id FROM team_members
       WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );
