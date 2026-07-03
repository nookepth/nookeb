-- หนูเก็บ (nookeb) — reliability & correctness hardening
-- Apply via: supabase db push  (or paste into the Supabase SQL editor)
--
-- 1. Atomic storage accounting (fixes the read-modify-write race under worker
--    concurrency). The API/worker call this RPC instead of SELECT-then-UPDATE.
-- 2. purged_at tombstone marker so the daily purge job stops re-scanning files
--    whose R2 objects are already gone.
-- 3. Bring the storage_limit default in line with the 10 GB free tier.

-- 1. Atomic increment (delta may be negative to free space). Clamps at 0 and
--    returns the new value. Row-level UPDATE is atomic, so concurrent uploads
--    can no longer lose writes to each other.
CREATE OR REPLACE FUNCTION increment_storage_used(p_user_id UUID, p_delta BIGINT)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  new_used BIGINT;
BEGIN
  UPDATE users
     SET storage_used = GREATEST(0, storage_used + p_delta),
         updated_at   = NOW()
   WHERE id = p_user_id
  RETURNING storage_used INTO new_used;
  RETURN new_used;
END;
$$;

-- 2. Mark objects the purge job has already removed from R2 (row kept as tombstone)
ALTER TABLE files ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ;

-- Only soft-deleted-but-not-yet-purged rows are interesting to the purge scan
CREATE INDEX IF NOT EXISTS idx_files_purge_candidates
  ON files (deleted_at)
  WHERE deleted_at IS NOT NULL AND purged_at IS NULL;

-- 3. 10 GB free tier (matches DEFAULT_STORAGE_LIMIT / CLAUDE.md).
--    Only changes the column default for future inserts — existing rows are
--    untouched (users created through the app already get the config value).
ALTER TABLE users ALTER COLUMN storage_limit SET DEFAULT 10737418240; -- 10 GB
