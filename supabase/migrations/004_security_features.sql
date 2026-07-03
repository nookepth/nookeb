-- 004_security_features.sql
-- Security & reliability features: virus-scan status per file + storage-alert
-- dedupe tracking per space.
-- NOT auto-applied — run via `supabase db push` or the Supabase SQL editor
-- BEFORE deploying code that writes files.scan_status / space_storage_alerts.

-- Virus-scan outcome per file. NULL = uploaded before scanning existed, or the
-- scanning feature is disabled (no VIRUSTOTAL_API_KEY).
ALTER TABLE files
  ADD COLUMN IF NOT EXISTS scan_status VARCHAR(20)
  CHECK (scan_status IN ('clean', 'skipped_size', 'scan_failed', 'malicious'));

-- One row per space tracking the last storage-warning threshold the owner was
-- notified about (80 or 95). Cleared (set NULL) when usage drops below 70% so
-- the owner is warned again if usage climbs back.
CREATE TABLE IF NOT EXISTS space_storage_alerts (
  space_id                 UUID PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
  last_notified_threshold  INTEGER,      -- 80 or 95, NULL = re-armed
  notified_at              TIMESTAMPTZ,
  updated_at               TIMESTAMPTZ DEFAULT now()
);
