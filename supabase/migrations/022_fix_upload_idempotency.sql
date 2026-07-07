-- 022_fix_upload_idempotency.sql
-- Idempotency backstop for normal uploads (upload_batch).
--
-- Problem: `upload_batch` jobs inherit attempts: 3 (defaultJobOptions) and BullMQ
-- also re-runs STALLED jobs when a worker restarts mid-batch. `storeUpload` had no
-- dedup guard and `files.line_message_id` had no uniqueness, so a worker restart (or
-- a LINE webhook redelivery, deliveryContext.isRedelivery) could store every file in
-- the batch a SECOND time — and double-charge the storage ledger, corrupting it
-- permanently. (Scan pages already dedup by line_message_id in code; normal uploads
-- did not.) The app now sets attempts: 1 on upload_batch and pre-checks the message
-- id, but the true guard is this unique index: it makes a duplicate INSERT fail at
-- the DB (23505) even under a race, so a file can be stored at most once.
--
-- Partial index rationale:
--   • line_message_id IS NOT NULL — server-generated files (merged scan PDFs) store a
--     NULL line_message_id; several of those must be allowed, so NULLs are excluded.
--   • deleted_at IS NULL — soft-deleted rows are kept as tombstones (rule 6). If a
--     user deletes a file and re-sends the same LINE image later, that must be allowed,
--     so only LIVE rows are constrained.
--
-- Backward-compatible: existing NULL / soft-deleted rows are unaffected. If duplicate
-- LIVE rows for one line_message_id already exist, this CREATE will fail — de-dup them
-- first (keep the earliest, soft-delete the rest) before applying.
--
-- NOT auto-applied — run via `supabase db push` or the Supabase SQL editor.

CREATE UNIQUE INDEX IF NOT EXISTS uq_files_line_message_id
  ON files (line_message_id)
  WHERE line_message_id IS NOT NULL AND deleted_at IS NULL;
