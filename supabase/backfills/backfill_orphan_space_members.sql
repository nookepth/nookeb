-- backfill_orphan_space_members.sql — one-time cleanup for FIX #1.
-- Run manually in the Supabase SQL editor AFTER deploying the code that revokes
-- space_members on team leave/removal/delete (team.service.ts / team.router.ts).
--
-- Removes space_members rows that grant access to TEAM-linked spaces for users
-- who are no longer members of the owning team (they left / were removed before
-- the revocation fix existed, so their rows were never cleaned up).
--
-- NOTE: space_members has a composite PK (space_id, user_id) — there is no
-- sm.id column — so the deletes join on the composite key via USING.
--
-- Three cases:
--   1. Space directly linked to a live team via spaces.team_id (migration 007):
--      drop members who have no team_members row for that team.
--   2. Space linked only through its LINE-group binding (spaces created lazily
--      by ensureGroupSpace never get team_id stamped): resolve the team through
--      team_line_groups and apply the same rule.
--   3. Space linked to a SOFT-DELETED team: the team is gone, so nobody should
--      retain member access through it.
--
-- Unbound group spaces (type='team', no team anywhere) are NOT touched — their
-- membership legitimately mirrors LINE-group participation.

BEGIN;

-- Case 1: spaces.team_id → live team, user not (or no longer) a team member.
DELETE FROM space_members sm
USING spaces s
JOIN teams t ON t.id = s.team_id AND t.deleted_at IS NULL
WHERE s.id = sm.space_id
  AND NOT EXISTS (
    SELECT 1 FROM team_members tm
    WHERE tm.team_id = s.team_id AND tm.user_id = sm.user_id
  );

-- Case 2: space linked via LINE-group binding only (spaces.team_id IS NULL).
DELETE FROM space_members sm
USING spaces s
JOIN team_line_groups tlg ON tlg.line_group_id = s.line_group_id
JOIN teams t ON t.id = tlg.team_id AND t.deleted_at IS NULL
WHERE s.id = sm.space_id
  AND s.team_id IS NULL
  AND s.type = 'team'
  AND NOT EXISTS (
    SELECT 1 FROM team_members tm
    WHERE tm.team_id = tlg.team_id AND tm.user_id = sm.user_id
  );

-- Case 3: space stamped with a soft-deleted team → revoke all members
-- (mirrors what deleteTeam now does going forward).
DELETE FROM space_members sm
USING spaces s
JOIN teams t ON t.id = s.team_id AND t.deleted_at IS NOT NULL
WHERE s.id = sm.space_id;

COMMIT;

-- Verification (should return 0 rows):
-- SELECT sm.space_id, sm.user_id
-- FROM space_members sm
-- JOIN spaces s ON s.id = sm.space_id
-- JOIN teams t ON t.id = s.team_id AND t.deleted_at IS NULL
-- WHERE NOT EXISTS (
--   SELECT 1 FROM team_members tm
--   WHERE tm.team_id = s.team_id AND tm.user_id = sm.user_id
-- );
