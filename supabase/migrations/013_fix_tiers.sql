-- 013_fix_tiers.sql — correct the referral storage tier thresholds.
-- NOT auto-applied — run manually via the Supabase SQL editor (or `supabase db push`).
--
-- Old thresholds (migration 010): 0→1, 1→3, 4→5, 7→7, 10→10 GB.
-- New thresholds:                 0→1, 3→3, 5→5, 7→7, 10→10 GB.
--
-- referral_tiers has min_referrals as its PRIMARY KEY, so the old (1,…) and (4,…)
-- rows would otherwise linger; TRUNCATE clears the table before reseeding.

TRUNCATE TABLE referral_tiers;
INSERT INTO referral_tiers (min_referrals, storage_limit_gb)
VALUES (0, 1), (3, 3), (5, 5), (7, 7), (10, 10);
