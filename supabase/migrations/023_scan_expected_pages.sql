-- 023_scan_expected_pages.sql
-- Fixes a silent data-loss race in the scan/merge flow: typing "เสร็จ" flips the
-- session to 'processing' and enqueues finalize_scan immediately, but any
-- add_scan_page jobs still queued (or in a 5s CDN-retry backoff) then hit
-- session.status !== 'collecting' and were dropped from the PDF with no error.
--
-- expected_pages records how many image events the webhook ACCEPTED for a session
-- (one atomic increment per image event). finalize_scan compares it against the
-- COUNT(*) of scan_pages actually stored and waits (bounded re-enqueue) until the
-- in-flight add_scan_page jobs land before assembling the PDF.
--
-- Backward-compatible: the column is nullable with DEFAULT 0 and needs no backfill.
-- Code reads it as `expected_pages ?? 0`, so if this migration isn't applied yet the
-- wait-gate simply no-ops (expected=0) and finalize behaves exactly like before.
--
-- NOT auto-applied — run via `supabase db push` or the Supabase SQL editor BEFORE
-- deploying the API/worker code that reads/writes it.

ALTER TABLE scan_sessions
  ADD COLUMN IF NOT EXISTS expected_pages INTEGER DEFAULT 0;

-- Atomic increment (webhook processes image events concurrently — a read-modify-write
-- in app code would race). Mirrors the increment_storage_used pattern (migration 003).
CREATE OR REPLACE FUNCTION increment_expected_pages(p_session_id UUID)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE scan_sessions
  SET expected_pages = COALESCE(expected_pages, 0) + 1
  WHERE id = p_session_id;
$$;
