-- backfill_vault_storage.sql — recompute users.storage_used to INCLUDE ห้องนิรภัย.
--
-- Context: vault files were originally, deliberately, NOT charged to
-- users.storage_used (they had their own VAULT_MAX_FILE_SIZE_MB cap instead).
-- That was reversed — the vault now shares the single personal storage pool —
-- and POST /vault/upload charges storage_used from that change onward. This
-- backfill covers the rows that predate it.
--
-- Run manually in the Supabase SQL editor AFTER migration 031 and AFTER the
-- API deploy that charges vault uploads. Running it BEFORE that deploy is also
-- safe (it just goes stale again for any upload in the gap) — but running it
-- while an older API is live will undercount, so prefer after.
--
-- IDEMPOTENT — this is a full RECOMPUTE, not an increment, so it is safe to
-- re-run at any time. That is deliberate: it doubles as the repair tool for the
-- two places vault accounting can drift (a best-effort charge that failed at
-- upload, or a refund lost to a crash mid-purge-sweep).
--
-- PREREQUISITE: run backfills/backfill_charged_to.sql first if it has never
-- been run. This recompute honours the charged_to ledger, and any team file
-- still mislabelled 'personal' would be wrongly billed to its uploader here.
--
-- The two halves of the sum use deliberately DIFFERENT liveness rules:
--   files  — live rows only (deleted_at IS NULL). A file's bytes are refunded
--            at SOFT delete (see DELETE /files/:id), so a soft-deleted file is
--            already uncharged even though its R2 object survives to the purge.
--   vault  — EVERY row, with no deleted_at filter. Vault bytes are refunded at
--            HARD purge instead, so "the row exists" is exactly "it is charged".
--            The purge hard-deletes the row, which is what ends the charge.
-- Do not "fix" the missing vault deleted_at filter — it would silently refund
-- every soft-deleted vault file 30 days early.

WITH computed AS (
  SELECT
    u.id,
    COALESCE((
      SELECT SUM(f.file_size)::BIGINT FROM files f
      WHERE f.uploaded_by = u.id
        AND f.deleted_at IS NULL
        AND f.charged_to = 'personal'
    ), 0) AS files_bytes,
    COALESCE((
      SELECT SUM(v.file_size)::BIGINT FROM vault_files v
      WHERE v.user_id = u.id
    ), 0) AS vault_bytes
  FROM users u
)
UPDATE users u
SET storage_used = c.files_bytes + c.vault_bytes
FROM computed c
WHERE c.id = u.id
  AND u.storage_used IS DISTINCT FROM c.files_bytes + c.vault_bytes;

-- Verify — expect zero rows. Anything returned is a user whose counter still
-- disagrees with the underlying files/vault rows.
--
-- WITH computed AS (
--   SELECT
--     u.id, u.display_name, u.storage_used,
--     COALESCE((
--       SELECT SUM(f.file_size)::BIGINT FROM files f
--       WHERE f.uploaded_by = u.id AND f.deleted_at IS NULL
--         AND f.charged_to = 'personal'
--     ), 0) AS files_bytes,
--     COALESCE((
--       SELECT SUM(v.file_size)::BIGINT FROM vault_files v
--       WHERE v.user_id = u.id
--     ), 0) AS vault_bytes
--   FROM users u
-- )
-- SELECT * FROM computed
-- WHERE storage_used IS DISTINCT FROM files_bytes + vault_bytes;
</content>
</invoke>
