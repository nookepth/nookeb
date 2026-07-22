-- 044_pdf_merge_session_kind.sql
-- ระบบรวมไฟล์ PDF (PDF Merge) — the 4th document feature, after รวมรูป / แปลงไฟล์ / สแกน.
--
-- It rides on the EXISTING scan_sessions/scan_pages plumbing rather than a table
-- of its own: session lifecycle (collecting → processing → done/cancelled), the
-- atomic page ordinal (page_seq, migration 018), the expected_pages wait-gate
-- (023), the result_file_id retry marker (018) and the scan-temp cleanup are all
-- kind-agnostic and already retry-safe. This migration only widens the
-- session_kind vocabulary by one value:
--   'merge' — รวมรูป      (images → one PDF; the DB default, preserves legacy rows)
--   'scan'  — สแกน        (scan-enhance pipeline → one PDF)
--   'pdf'   — รวมไฟล์ PDF (PDF files concatenated → one PDF)   ← NEW
--
-- A 'pdf' session's scan_pages rows point at *.pdf objects under the same
-- spaces/{sid}/scan-temp/{session}/ prefix (buildScanPageKey now takes an
-- extension). Nothing else in the schema changes.
--
-- One active session per user is what makes "เสร็จ"/"ยกเลิก" unambiguous across
-- all three kinds — do NOT split this into a parallel session table.
--
-- NOT auto-applied; apply BEFORE the API/worker deploy (startSession writes
-- 'pdf' and the CHECK would reject it). Purely a constraint widening — the
-- currently-deployed code keeps working once applied, so either order is safe.

ALTER TABLE scan_sessions
  DROP CONSTRAINT IF EXISTS scan_sessions_session_kind_check;

ALTER TABLE scan_sessions
  ADD CONSTRAINT scan_sessions_session_kind_check
  CHECK (session_kind IN ('scan', 'merge', 'pdf'));
