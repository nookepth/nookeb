-- 030_referral_tiers_fractional.sql — new referral ladder: 0→1, 3→2.5, 5→4 GB.
-- NOT auto-applied — run manually via the Supabase SQL editor (or `supabase db push`)
-- BEFORE deploying the API/worker that reads the new tiers.
--
-- Old thresholds (migration 013): 0→1, 3→3, 5→5, 7→7, 10→10 GB.
-- New thresholds:                 0→1, 3→2.5, 5→4 GB. The 7- and 10-referral
-- rungs are gone — 5 referrals is now the top tier and there is no 10-referral
-- cap anywhere; referral_count simply keeps counting past it with no further grant.
--
-- storage_limit_gb was INTEGER, which cannot hold 2.5 — widened to NUMERIC(6,2).
-- redeem_referral is recreated because its v_tier_gb local was INTEGER too: the
-- SELECT ... INTO would have silently rounded 2.5 → 3. The GREATEST() guard from
-- migration 024 (redeem may only RAISE a limit, never lower it) is preserved, so
-- existing users sitting on the old 3/5/7/10 GB tiers keep their current limit.

ALTER TABLE referral_tiers
  ALTER COLUMN storage_limit_gb TYPE NUMERIC(6,2);

-- min_referrals is the PRIMARY KEY, so the retired (7,…) and (10,…) rows would
-- otherwise linger; TRUNCATE clears the table before reseeding.
TRUNCATE TABLE referral_tiers;
INSERT INTO referral_tiers (min_referrals, storage_limit_gb)
VALUES (0, 1), (3, 2.5), (5, 4);

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
  v_tier_gb       NUMERIC;
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
    -- Never lower an existing storage_limit — admin overrides and users already
    -- on the retired higher tiers must be preserved. ROUND() because a
    -- fractional tier (2.5 GB) is no longer a whole number of bytes by construction.
    UPDATE users
       SET storage_limit = GREATEST(
                             storage_limit,
                             ROUND(v_tier_gb * 1073741824)::BIGINT
                               + CASE WHEN v_referrer_has_bonus THEN p_bonus_bytes ELSE 0 END
                           ),
           updated_at    = NOW()
     WHERE id = p_referrer_id;
  END IF;

  RETURN v_referee_limit;
END;
$$;
