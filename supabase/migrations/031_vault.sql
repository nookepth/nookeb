-- 031_vault.sql
-- "ห้องนิรภัย" (Vault) — PIN-protected, view-only, per-user encrypted file store.
--
-- Vault files are DELIBERATELY isolated from the files/spaces model (same
-- pattern as diary_entries, migration 028): they never appear in the locker,
-- can never be shared (no share/team/space code path can reach this table),
-- and upload is WEB-ONLY (nothing in the LINE webhook/worker writes here).
--
-- Encryption (services/vault-crypto.ts): every file is AES-256-GCM encrypted
-- BEFORE it reaches R2 under `vault/{user_id}/{uuid}.enc`, with a random
-- per-file DEK that is itself wrapped (AES-256-GCM) under a per-user key
-- derived from VAULT_MASTER_KEY via scrypt. A leaked R2 credential therefore
-- yields only ciphertext. The columns store R2 KEYS and wrapped key material,
-- never URLs and never plaintext keys.
--
-- Access: no presigned URLs — vault reads always stream through the API
-- (deliberate, approved deviation from engineering rule 5: a presigned URL is
-- shareable for its whole TTL, which is exactly what the vault must prevent).
--
-- Deletion: soft delete (deleted_at) like everything else, but after the
-- 30-day retention window the daily purge HARD-deletes the row along with the
-- R2 object (deliberate, vault-scoped deviation from rule 6's tombstones: a
-- vault row's filename is itself sensitive content, and vault files are not
-- part of quota accounting, so nothing needs the tombstone).
--
-- NOT auto-applied — run in the Supabase SQL editor BEFORE deploying the
-- vault code (the /vault routes error without these columns).

-- PIN (argon2id hash — never plaintext) + manual premium gate. vault_plan is
-- a placeholder until billing lands: 'free' | 'premium'.
ALTER TABLE users ADD COLUMN IF NOT EXISTS vault_pin_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS vault_plan TEXT NOT NULL DEFAULT 'free';

CREATE TABLE IF NOT EXISTS vault_files (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  r2_key            TEXT NOT NULL,        -- vault/{user_id}/{uuid}.enc (ciphertext || 16-byte GCM tag)
  original_filename TEXT NOT NULL,
  mime_type         TEXT NOT NULL,        -- allowlist enforced in routes/vault.ts
  file_size         BIGINT NOT NULL,      -- PLAINTEXT bytes (ciphertext is +16)
  dek_encrypted     TEXT NOT NULL,        -- base64(iv || tag || wrapped DEK) under the per-user key
  iv                TEXT NOT NULL,        -- base64 12-byte IV of the FILE encryption
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ           -- soft delete; hard-purged after retention (see header)
);

-- Listing: all live files for a user, newest first.
CREATE INDEX IF NOT EXISTS idx_vault_files_user_live
  ON vault_files (user_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Daily purge scan: soft-deleted rows past retention.
CREATE INDEX IF NOT EXISTS idx_vault_files_purge_pending
  ON vault_files (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- RLS backstop, mirroring files/diary (the API uses the service-role key which
-- bypasses RLS — ownership is enforced in the routes; this guards direct access).
ALTER TABLE vault_files ENABLE ROW LEVEL SECURITY;
