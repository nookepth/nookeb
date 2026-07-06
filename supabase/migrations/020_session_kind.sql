-- 020_session_kind.sql
-- Which feature opened a scan_sessions row:
--   'merge' — the "รวมรูป" merge-to-PDF flow (default; preserves legacy rows)
--   'scan'  — the "สแกน" scan-to-PDF flow (scan-enhance pipeline)
-- Both kinds share the scan_sessions/scan_pages plumbing and the finalize_scan
-- job, but the produced PDF's filename prefix ("สแกน_" vs "รวมรูป_") and the
-- confirmation cards ("ระบบสแกน" vs "ระบบรวมรูป") differ per kind. Set at
-- startSession (webhook/line.ts); read by the worker in finalize_scan and by the
-- per-page reply card. Apply BEFORE deploying the code that reads it.

ALTER TABLE scan_sessions
  ADD COLUMN IF NOT EXISTS session_kind TEXT NOT NULL DEFAULT 'merge'
  CHECK (session_kind IN ('scan', 'merge'));
