-- 040_pro_interest_authed.sql
-- Fake-door demand test for the two unbuilt Task-Manager Pro features
-- (Auto Task Reminder / Voice Command), surfaced on the LIFF task pages.
--
-- This is DELIBERATELY DIFFERENT from pro_interest_log (migration 034):
--   * pro_interest_log is the gift-box demand test — UNAUTHENTICATED and
--     anonymous (no user_id, no dedupe), because its create flow is a public
--     surface. Nothing identity-bearing may ever be built on it.
--   * pro_interest (this table) is written only from the AUTHENTICATED LIFF
--     task pages (LIFF id token -> app session cookie), so we can and do record
--     WHO tapped and dedupe one interest record per (user_id, feature_id). That
--     is what powers the per-feature "views vs unique clicks -> conversion %"
--     view on the admin Pro-Interest dashboard.
-- The two tables are intentionally kept separate; do not merge them.
--
-- NOT auto-applied — run in the Supabase SQL editor BEFORE deploying the API
-- (POST/GET /pro-interest error without this table; nothing else is affected).
-- Additive only.

CREATE TABLE pro_interest (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- keep in sync with TASK_PRO_FEATURE_IDS in the web app (ProFeatureSection)
  feature_id VARCHAR(50) NOT NULL
    CHECK (feature_id IN ('task_auto_reminder', 'task_voice_command')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- one interest record per user per feature: the second "แจ้งเตือนฉัน" tap is a
  -- no-op (ON CONFLICT DO NOTHING), so unique-clicks == unique interested users.
  UNIQUE (user_id, feature_id)
);

-- The read patterns are "unique clicks per feature" and "clicks/day trend".
CREATE INDEX idx_pro_interest_feature_created
  ON pro_interest (feature_id, created_at DESC);

-- RLS on with NO policies = deny-all backstop (rule 4). The API/worker use the
-- service-role key, which bypasses RLS; membership/ownership is enforced in the
-- route. Same posture as the task tables (migration 036) and the RLS backstop
-- sweep (migration 038).
ALTER TABLE pro_interest ENABLE ROW LEVEL SECURITY;
