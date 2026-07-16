-- 032_trash.sql
-- ถังขยะ (Trash Bin) — restore-from-trash support for the web dashboard.
--
-- Soft delete (rule 6) already gives us the trash itself: a deleted file is a
-- `deleted_at IS NOT NULL AND purged_at IS NULL` row whose R2 object survives
-- until the daily purge. What restore additionally needs is WHERE the file
-- lived, snapshotted at delete time: DELETE /files/:id copies folder_id into
-- this column before clearing anything, and ON DELETE SET NULL lets Postgres
-- itself null the snapshot if the origin folder is hard-deleted while the file
-- sits in the trash (folders are hard rows — same FK behavior as
-- files.folder_id) — restore then falls back to the space root.
--
-- NOT auto-applied — run in the Supabase SQL editor BEFORE deploying the
-- trash code (DELETE /files/:id writes this column and errors without it).

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS trash_origin_folder_id UUID REFERENCES folders(id) ON DELETE SET NULL;
