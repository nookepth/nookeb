-- 006_cleanup_stale_team_spaces.sql
-- One-time cleanup of legacy team-type space rows named '1' / '2'. These were
-- created by an older team flow (removed in the teams refactor) and now show up
-- in the dashboard switcher as "ทีม · 1" / "ทีม · 2". Real group spaces are named
-- 'คลังกลุ่ม' and are linked to a team via line_group_id — those are NOT touched.
--
-- SAFETY: only delete stale spaces that have NO files referencing them (deleted
-- or not) and NO LINE-group binding, so we can never orphan stored files.
-- NOT auto-applied — run via `supabase db push` or the SQL editor.

BEGIN;

-- Candidate stale spaces: team-type, named '1' or '2', not bound to any group,
-- and with no files at all.
WITH stale AS (
  SELECT s.id
  FROM spaces s
  WHERE s.type = 'team'
    AND s.name IN ('1', '2')
    AND s.line_group_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM files f WHERE f.space_id = s.id)
)
DELETE FROM space_members sm
USING stale
WHERE sm.space_id = stale.id;

WITH stale AS (
  SELECT s.id
  FROM spaces s
  WHERE s.type = 'team'
    AND s.name IN ('1', '2')
    AND s.line_group_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM files f WHERE f.space_id = s.id)
)
DELETE FROM spaces s
USING stale
WHERE s.id = stale.id;

COMMIT;
