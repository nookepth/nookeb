-- 012_reset_quota.sql — one-time clean slate for the referral launch.
-- NOT auto-applied — run manually in the Supabase SQL editor (or `supabase db push`).
--
-- Resets EVERY user (including admins) to the 1 GB free tier and clears all
-- referral progress. Intentional: from now on the referral system is the only
-- way to hold more than 1 GB. referral_code is deliberately KEPT — users keep
-- the code they may have already shared; only counts/limits/redemptions reset.

UPDATE users
SET
  storage_limit  = 1073741824,  -- exactly 1 GB in bytes
  referral_count = 0,
  referred_by_id = NULL,
  updated_at     = NOW();

-- Clear all existing referral records (fresh start).
TRUNCATE TABLE referrals;
