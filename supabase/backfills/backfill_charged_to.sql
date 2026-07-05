-- backfill_charged_to.sql — one-time backfill for FIX #3.
-- Run manually in the Supabase SQL editor AFTER migration 015 (which adds the
-- columns; the ADD COLUMN default already set every existing row to 'personal').
--
-- Files still linked to a team were charged to that TEAM's quota — stamp the
-- ledger accordingly. Rows with team_id IS NULL stay 'personal' (best-effort:
-- files detached by an earlier deleteTeam are indistinguishable from genuine
-- personal uploads in historical data — acknowledged and accepted).

UPDATE files
SET charged_to = 'team',
    charged_team_id = team_id
WHERE team_id IS NOT NULL
  AND charged_to = 'personal';   -- idempotent: safe to re-run
