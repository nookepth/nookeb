-- 010_referrals.sql — referral-based storage tiers.
-- NOT auto-applied — run via `supabase db push` or the Supabase SQL editor
-- BEFORE deploying code that uses referral_code / referrals / redeem_referral.
--
-- Model:
-- * Free tier drops to 1 GB (DEFAULT_STORAGE_LIMIT). Inviting people raises the
--   inviter's limit via referral_tiers; redeeming someone's code gives the
--   redeemer a one-time flat bonus (REFERRAL_BONUS_BYTES, 0.5 GB).
-- * A user's limit = tier(referral_count) + one-time bonus (if they redeemed).
-- * All redeem mutations happen atomically inside the redeem_referral RPC —
--   same rule as increment_storage_used (003): callers never read-modify-write.

-- users gain referral fields
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code   VARCHAR(8) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_id  UUID REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_count  INTEGER NOT NULL DEFAULT 0;

-- New free-tier default: 1 GB. Only affects future inserts — existing rows keep
-- their current limit (the app sets the config value explicitly on creation).
ALTER TABLE users ALTER COLUMN storage_limit SET DEFAULT 1073741824; -- 1 GB

-- REFERRALS — one row per successful redemption. UNIQUE(referee_id) is the
-- hard guarantee a user can only ever redeem one code.
CREATE TABLE IF NOT EXISTS referrals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referee_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (referee_id),
  CHECK (referrer_id <> referee_id)
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referee_id  ON referrals(referee_id);

-- REFERRAL_TIERS — storage granted per referral count (highest matching row wins)
CREATE TABLE IF NOT EXISTS referral_tiers (
  min_referrals    INTEGER PRIMARY KEY,
  storage_limit_gb INTEGER NOT NULL
);

INSERT INTO referral_tiers (min_referrals, storage_limit_gb) VALUES
  (0, 1),
  (1, 3),
  (4, 5),
  (7, 7),
  (10, 10)
ON CONFLICT (min_referrals) DO NOTHING;

-- Atomic redemption (the Supabase JS client has no transactions — see 003).
-- Inserts the referrals row, gives the referee the flat bonus, bumps the
-- referrer's count and recalculates the referrer's limit from the tier table
-- (preserving the referrer's own one-time bonus if they redeemed a code too).
-- Returns the referee's new storage_limit in bytes.
-- Raises on double-redeem (UNIQUE referee_id / referred_by_id guard) or
-- self-referral (CHECK) — everything rolls back together.
CREATE OR REPLACE FUNCTION redeem_referral(
  p_referrer_id UUID,
  p_referee_id  UUID,
  p_bonus_bytes BIGINT
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_referee_limit BIGINT;
  v_new_count     INTEGER;
  v_tier_gb       INTEGER;
  v_referrer_has_bonus BOOLEAN;
BEGIN
  INSERT INTO referrals (referrer_id, referee_id)
  VALUES (p_referrer_id, p_referee_id);

  -- Referee: mark who referred them + one-time flat bonus.
  -- referred_by_id IS NULL guard: if it's somehow already set without a
  -- referrals row, refuse rather than double-grant.
  UPDATE users
     SET referred_by_id = p_referrer_id,
         storage_limit  = storage_limit + p_bonus_bytes,
         updated_at     = NOW()
   WHERE id = p_referee_id AND referred_by_id IS NULL
  RETURNING storage_limit INTO v_referee_limit;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'referee % already redeemed a code', p_referee_id
      USING ERRCODE = 'unique_violation';
  END IF;

  -- Referrer: bump count, then recalculate limit from the tier table.
  UPDATE users
     SET referral_count = referral_count + 1,
         updated_at     = NOW()
   WHERE id = p_referrer_id
  RETURNING referral_count, (referred_by_id IS NOT NULL)
       INTO v_new_count, v_referrer_has_bonus;

  SELECT storage_limit_gb INTO v_tier_gb
    FROM referral_tiers
   WHERE min_referrals <= v_new_count
   ORDER BY min_referrals DESC
   LIMIT 1;

  IF v_tier_gb IS NOT NULL THEN
    UPDATE users
       SET storage_limit = v_tier_gb::BIGINT * 1073741824
                           + CASE WHEN v_referrer_has_bonus THEN p_bonus_bytes ELSE 0 END,
           updated_at    = NOW()
     WHERE id = p_referrer_id;
  END IF;

  RETURN v_referee_limit;
END;
$$;
