-- 034_legacy_box_occasion_tagline.sql
-- กล่องของขวัญ (Legacy Box) — occasion + tagline authoring metadata, and the
-- pro_interest_log demand test.
--
-- Both new legacy_boxes columns are NULLABLE and carry no default: every box
-- created before this migration keeps occasion = NULL / tagline = NULL, which is
-- a valid, permanent state. The reveal page resolves a NULL tagline to
-- DEFAULT_TAGLINE ('ส่งมาด้วยความคิดถึง') — the string it hardcoded until now —
-- so old boxes render exactly as they did before. Nothing backfills them.
--
-- NOT auto-applied — run in the Supabase SQL editor BEFORE deploying the code
-- (POST /legacy-box writes both columns and errors without them). The columns
-- are additive, so the currently-deployed code keeps working after it is applied
-- but before the new code ships: safe in both orders, unlike a rename.

ALTER TABLE legacy_boxes
  -- keep in sync with OCCASIONS in packages/shared/src/legacy-box-occasions.ts
  -- (same discipline as the theme CHECK above it)
  ADD COLUMN occasion VARCHAR(50)
    CHECK (occasion IS NULL OR occasion IN (
      'birthday','anniversary','surprise','apology','longing','family','special'
    )),
  ADD COLUMN tagline  VARCHAR(60)
    CHECK (tagline IS NULL OR char_length(tagline) <= 60);

-- Demand test for the locked Pro entries in the create flow (audio / video).
-- Deliberately anonymous: no user_id, no IP, no session — it records only THAT
-- someone tapped, never who. The endpoint that writes it is unauthenticated, so
-- the counts are directional interest, not per-user truth; anything that needs
-- to identify a user must not be built on this table.
CREATE TABLE pro_interest_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature    VARCHAR(20) NOT NULL CHECK (feature IN ('audio','video')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The only read pattern is "how many taps per feature over a window".
CREATE INDEX idx_pro_interest_log_feature_created
  ON pro_interest_log (feature, created_at DESC);
