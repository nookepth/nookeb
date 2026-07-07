-- Add index on files.uploaded_by for /me/usage and admin queries
-- Use CONCURRENTLY to avoid locking the table during creation
-- Partial index excludes deleted rows (the common filter)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_files_uploaded_by
  ON files(uploaded_by)
  WHERE deleted_at IS NULL;

-- (Add any other missing indexes you find while reading the schema,
--  only if they are clearly missing and have confirmed query usage)
