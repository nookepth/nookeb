-- 007_spaces_team_id.sql
-- Add a DIRECT spaces → teams link so team-space names resolve with a simple
-- join, instead of the indirect spaces.line_group_id → team_line_groups → teams
-- path (which can't name a team space whose group isn't bound / is a legacy
-- orphan). NOT auto-applied — run via `supabase db push` or the SQL editor.

-- Nullable FK: a space may not belong to a team (personal spaces, or team-type
-- group spaces whose group isn't bound to a team). ON DELETE SET NULL so hard-
-- deleting a team never cascades away the space + its files.
ALTER TABLE spaces
  ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_spaces_team_id ON spaces(team_id) WHERE team_id IS NOT NULL;

-- Backfill existing team group spaces from the current line_group_id binding
-- (non-deleted teams only). Idempotent: only fills rows that aren't linked yet.
UPDATE spaces s
SET team_id = tlg.team_id
FROM team_line_groups tlg
JOIN teams t ON t.id = tlg.team_id AND t.deleted_at IS NULL
WHERE s.line_group_id = tlg.line_group_id
  AND s.type = 'team'
  AND s.team_id IS NULL;
