-- 027_file_shares.sql
-- Public share links for dashboard files. A user mints a link (token) for one
-- of their files; anyone holding the link can view/download WITHOUT logging in
-- (the public GET /share/:token endpoint uses the service-role key, so RLS is a
-- backstop — see engineering rule 4). Multiple links per file are allowed, each
-- with its own expiry / view counter (audit trail).
--
-- NOT auto-applied — run via `supabase db push` or the Supabase SQL editor
-- BEFORE deploying the API code that reads/writes this table.

-- gen_random_bytes() lives in pgcrypto (gen_random_uuid() is core, this is not).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS file_shares (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id    UUID        NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  created_by UUID        NOT NULL REFERENCES users(id),
  -- 32 random bytes → 64 hex chars. DB-generated so the token is never built in
  -- the app layer (engineering constraint).
  token      TEXT        NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  expires_at TIMESTAMPTZ,               -- NULL = never expires
  max_views  INTEGER,                   -- NULL = unlimited
  view_count INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_file_shares_token ON file_shares(token);
CREATE INDEX IF NOT EXISTS idx_file_shares_file_id ON file_shares(file_id);

-- RLS backstop (the API/worker use the service-role key, which BYPASSES this;
-- membership/ownership is enforced explicitly in the routes). Owner may manage
-- their own shares; the public viewer resolves tokens through the service role.
ALTER TABLE file_shares ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_manages_own_shares" ON file_shares
  FOR ALL USING (created_by = auth.uid());
