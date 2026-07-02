-- หนูเก็บ (nookeb) — Phase 4: Google Drive export
-- Stores the per-user Google OAuth refresh token so the app can upload to Drive.
-- Apply via: supabase db push  (or paste into the Supabase SQL editor)

CREATE TABLE IF NOT EXISTS google_accounts (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  refresh_token TEXT NOT NULL,
  email         TEXT,
  connected_at  TIMESTAMPTZ DEFAULT NOW()
);
