-- 050_task_urgency.sql
--
-- ความเร่งด่วน picked at task creation (Part G, 2026-08-01): four levels the
-- LIFF create flow and the dashboard's personal-task modal offer as buttons.
-- Stored as canonical keys, NOT the Thai display labels — the labels
-- (🔴 ด่วนมาก / 🟠 ด่วน / 🟡 ปกติ / 🟢 ไม่รีบ) are presentation, owned by the
-- web UI and the Google Sheets workspace mapping (sheets-row.ts), and renaming
-- a label must never require a data migration.
--
-- NULL = not chosen (pre-050 tasks, in-chat command tasks) and renders as
-- ปกติ everywhere, so no backfill is needed.
--
-- APPLY ORDER: before deploying the API/web that sends `urgency`. Either-order
-- safe for older clients — inserts omit the column when no value was chosen —
-- but the new UI always sends one, so its inserts fail until this is applied.
--
-- Apply manually in the Supabase SQL editor (no auto-migration tooling).

ALTER TABLE tasks
  ADD COLUMN urgency TEXT NULL
  CHECK (urgency IN ('urgent_max', 'urgent', 'normal', 'relaxed'));

COMMENT ON COLUMN tasks.urgency IS
  'ความเร่งด่วน chosen at creation (048). NULL = default (ปกติ). Mirrored into the Google Sheets workspace column K on first sync of the row.';
