-- 024_fix_referral_quota.sql — stop referral redemption from clobbering admin quotas.
-- NOT auto-applied — run via `supabase db push` or the Supabase SQL editor.
--
-- Bug: the referrer's storage_limit UPDATE in redeem_referral (010) RECALCULATED
-- the limit from tier + bonus and OVERWROTE whatever was there. If an admin had
-- set a higher (or arbitrary) limit via PATCH /admin/users/:id, every new redeem
-- would reset it to the tier value — potentially dropping the user below their
-- current storage_used and instantly blocking all their uploads.
--
-- Fix: wrap the target value in GREATEST(storage_limit, ...) so redeem can only
-- ever RAISE the limit, never lower it. This is the ONLY change vs. 010 —
-- referral counts, the referee bonus, and the bonus calculation are untouched.

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
    -- Never lower an existing storage_limit — admin overrides must be
    -- preserved. GREATEST() ensures referral bonuses are additive, not replacement.
    UPDATE users
       SET storage_limit = GREATEST(
                             storage_limit,
                             v_tier_gb::BIGINT * 1073741824
                               + CASE WHEN v_referrer_has_bonus THEN p_bonus_bytes ELSE 0 END
                           ),
           updated_at    = NOW()
     WHERE id = p_referrer_id;
  END IF;

  RETURN v_referee_limit;
END;
$$;
