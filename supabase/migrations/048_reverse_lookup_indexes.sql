-- 048: two missing reverse-lookup indexes on junction tables.
--
-- Both tables have a COMPOSITE PRIMARY KEY, which Postgres backs with a single
-- index that can only be used when the query constrains the LEADING column.
-- Each is queried on its SECOND column alone on a hot path, so neither query
-- has an index today and both degrade into a sequential scan that grows with
-- total table size (not with the user's own row count):
--
--   space_members  PK (space_id, user_id)  →  queried by user_id alone in
--     ensureUserAndSpace() (every LINE upload, every login) and GET /auth/me:
--       .from('space_members').select('space_id, spaces!inner(*)').eq('user_id', …)
--
--   file_tags      PK (file_id, tag_id)    →  queried by tag_id alone in
--     GET /files?tagId= and GET /files/stats?tagId= (the dashboard tag filter):
--       .from('file_tags').select('file_id').eq('tag_id', …)
--
-- (The reverse direction of each is already covered by the PK's leading column:
-- space_id lookups and file_id lookups need nothing extra.)
--
-- PURELY ADDITIVE — indexes only, no schema or behaviour change, so this is safe
-- to apply at any time, before or after a deploy, and safe to re-run.
--
-- CONCURRENTLY avoids taking a write lock on a live table (same convention as
-- migration 025). NOTE: CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block — run these statements one at a time in the Supabase SQL
-- editor, not wrapped in BEGIN/COMMIT.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_space_members_user_id
  ON space_members(user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_file_tags_tag_id
  ON file_tags(tag_id);
