-- 021_group_notify_settings.sql
-- Per-group toggle for the upload confirmation reply ("บันทึกแล้วน้า ✓") that the
-- webhook sends after a file is stored in a GROUP/ROOM chat. Default TRUE keeps the
-- existing behavior for every group that has never touched the setting, so this is
-- backward-compatible with no backfill.
--
-- Keyed by the LINE group id (or room id for OpenChat) — the same value the webhook
-- already uses to route group uploads. `updated_by` records the LINE user id who
-- last flipped it (social accountability; the toggle is open to any group member —
-- LINE's Messaging API can't expose group-admin role). Read on every group upload,
-- so the service caches it in-memory for 5 min (see group-settings.service.ts).
--
-- NOT auto-applied — run via `supabase db push` or the Supabase SQL editor BEFORE
-- deploying the code that reads/writes it (the code fails open to notify=TRUE if the
-- table is missing, so an early deploy just behaves like today).

CREATE TABLE IF NOT EXISTS group_notify_settings (
  line_group_id  TEXT PRIMARY KEY,
  notify_on_save BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_by     TEXT,                 -- LINE userId who last changed it
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
