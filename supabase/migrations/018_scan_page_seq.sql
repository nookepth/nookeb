-- 018_scan_page_seq.sql
-- Per-session scan page ordering was computed in application code as
-- (SELECT COUNT(*) ... ) + 1, which is NOT atomic. With worker concurrency 5,
-- two pages for the same session can both read count=N and both insert
-- page_number=N+1 → duplicate ordinals. Assign the ordinal atomically at INSERT
-- time via a DB-managed sequence instead, and order pages by it.
--
-- page_seq is a single global BIGSERIAL: it is strictly monotonic in insert
-- order, so within a session it yields a stable, gap-tolerant, duplicate-free
-- ordering (we only rely on relative order per session, not on 1..N values).

ALTER TABLE scan_pages ADD COLUMN IF NOT EXISTS page_seq BIGSERIAL;

-- page_number is now assigned by the DB (page_seq); the legacy column is kept
-- for back-compat but no longer written, so it must allow NULL.
ALTER TABLE scan_pages ALTER COLUMN page_number DROP NOT NULL;

-- Order pages within a session by the atomic sequence.
CREATE INDEX IF NOT EXISTS idx_scan_pages_session_seq
  ON scan_pages(session_id, page_seq);
