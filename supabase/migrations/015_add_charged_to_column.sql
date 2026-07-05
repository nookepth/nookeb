-- 015_add_charged_to_column.sql — record WHICH quota ledger paid for each file.
-- NOT auto-applied — run via `supabase db push` or the Supabase SQL editor.
-- MUST be applied BEFORE deploying worker code that inserts charged_to /
-- charged_team_id (team-file inserts would otherwise fail), and BEFORE running
-- backfills/backfill_charged_to.sql.
--
-- Root cause fixed: deleteTeam sets files.team_id = NULL, so deleting such a
-- file later refunded the UPLOADER's personal quota — which was never charged
-- (the TEAM quota was). The refund must follow the ledger that was charged, so
-- we record it explicitly at upload time.
--
-- charged_team_id deliberately stays set when the team is soft-deleted (teams
-- are never hard-deleted); refunding a soft-deleted team's counter is harmless,
-- and crucially the uploader's personal quota is never touched. ON DELETE SET
-- NULL only fires on a hard DELETE of the teams row — in that case the refund
-- is dropped entirely (quota already lost with the team; acceptable).

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS charged_to TEXT NOT NULL DEFAULT 'personal'
  CHECK (charged_to IN ('personal', 'team'));

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS charged_team_id UUID REFERENCES teams(id) ON DELETE SET NULL;
