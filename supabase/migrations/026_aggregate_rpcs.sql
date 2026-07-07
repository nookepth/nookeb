-- Aggregate helpers so the admin/analytics endpoints count files in SQL instead
-- of pulling every file row into JS and counting with .length / .reduce.
-- PostgREST caps a plain select at 1000 rows by default, so those JS counts
-- silently under-report once a user/space/table crosses 1000 files. These
-- functions do the GROUP BY server-side and return one row per group.
--
-- All are STABLE / read-only. CREATE OR REPLACE keeps this migration re-runnable.

-- Per-user non-deleted file counts (admin/users)
CREATE OR REPLACE FUNCTION admin_file_counts_by_user()
RETURNS TABLE(uploaded_by UUID, file_count BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT uploaded_by, COUNT(*)::BIGINT AS file_count
  FROM files
  WHERE deleted_at IS NULL AND uploaded_by IS NOT NULL
  GROUP BY uploaded_by;
$$;

-- Per-space non-deleted file count + byte totals (admin/spaces)
CREATE OR REPLACE FUNCTION admin_file_stats_by_space()
RETURNS TABLE(space_id UUID, file_count BIGINT, total_bytes BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT space_id,
         COUNT(*)::BIGINT AS file_count,
         COALESCE(SUM(file_size), 0)::BIGINT AS total_bytes
  FROM files
  WHERE deleted_at IS NULL
  GROUP BY space_id;
$$;

-- A single user's uploaded (non-deleted) files grouped by mime type
-- (analytics /me/usage byType — the category mapping stays in JS)
CREATE OR REPLACE FUNCTION usage_by_mime(p_user_id UUID)
RETURNS TABLE(mime_type TEXT, file_count BIGINT, total_bytes BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT mime_type,
         COUNT(*)::BIGINT AS file_count,
         COALESCE(SUM(file_size), 0)::BIGINT AS total_bytes
  FROM files
  WHERE uploaded_by = p_user_id AND deleted_at IS NULL
  GROUP BY mime_type;
$$;

-- Per-space file count + bytes for a set of spaces (analytics /me/usage spaces)
CREATE OR REPLACE FUNCTION usage_by_space(p_space_ids UUID[])
RETURNS TABLE(space_id UUID, file_count BIGINT, total_bytes BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT space_id,
         COUNT(*)::BIGINT AS file_count,
         COALESCE(SUM(file_size), 0)::BIGINT AS total_bytes
  FROM files
  WHERE space_id = ANY(p_space_ids) AND deleted_at IS NULL
  GROUP BY space_id;
$$;
