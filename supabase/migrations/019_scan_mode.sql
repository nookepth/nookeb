-- 019_scan_mode.sql
-- Per-session scan color mode for the scan-enhance pipeline:
--   'bw'    — adaptive-threshold black/white output (text documents; default)
--   'color' — normalize + sharpen + white-balance (documents with color/images)
-- Set by the LINE commands "สแกนขาวดำ" / "สแกนสี" (webhook/line.ts); read by the
-- worker in add_scan_page. Apply BEFORE deploying the worker code that reads it.

ALTER TABLE scan_sessions
  ADD COLUMN IF NOT EXISTS scan_mode TEXT NOT NULL DEFAULT 'bw'
  CHECK (scan_mode IN ('bw', 'color'));
