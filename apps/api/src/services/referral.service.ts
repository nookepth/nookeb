import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Redis } from 'ioredis';
import { config } from '../config';

const GB = 1024 * 1024 * 1024;
const CODE_LENGTH = 8;
const MAX_CODE_ATTEMPTS = 10;

const TIER_CACHE_KEY = 'referral:tiers';
const TIER_CACHE_TTL_SECONDS = 3600; // 1 hour

/** Referrals needed for the top tier (5 → 4 GB, migration 030) — the scale both
 * progress bars are drawn against. NOT a cap: referral_count keeps counting
 * past it, it just stops unlocking storage. */
const TOP_TIER_REFERRALS = 5;

// Postgres unique_violation — also raised by the redeem_referral RPC on double-redeem
const PG_UNIQUE_VIOLATION = '23505';

interface ReferralTier {
  min_referrals: number;
  /** May be fractional (2.5) — the column is NUMERIC since migration 030. */
  storage_limit_gb: number;
}

/** Machine-readable failure cause — lets the bot pick its own friendly copy
 * without string-matching the Thai `reason` the API returns. */
export type RedeemFailCode = 'self' | 'already_redeemed' | 'chain' | 'not_found';

export interface RedeemCheck {
  ok: boolean;
  reason?: string;
  reasonCode?: RedeemFailCode;
}

export interface RedeemResult {
  ok: boolean;
  /** set on success — the user whose code was redeemed (for the LINE push) */
  referrerId?: string;
  newStorageBytes?: number;
  reason?: string;
  reasonCode?: RedeemFailCode;
}

export interface ReferralStatus {
  code: string;
  referralCount: number;
  currentTierGB: number;
  /** null when already at the top tier */
  nextTierGB: number | null;
  /** referrals still needed to reach the next tier (0 when at top) */
  neededForNext: number;
  /** overall progress toward the top tier (5 referrals), 0–100 */
  progressPercent: number;
  /** the user this account redeemed a code from — null if they never redeemed */
  referredById: string | null;
}

/** 8 uppercase base36 chars from crypto-strength randomness (48 bits > 36^8 space needs ~41). */
function randomCode(): string {
  // 6 random bytes = 48 bits → up to 10 base36 digits; keep the last 8 (padStart
  // covers small values) so every position stays uniformly random enough for codes.
  const n = BigInt(`0x${randomBytes(6).toString('hex')}`);
  return n.toString(36).toUpperCase().padStart(CODE_LENGTH, '0').slice(-CODE_LENGTH);
}

/**
 * Assign the user a referral code if they don't have one yet, and return it.
 * Idempotent — an existing code is never overwritten (the UPDATE is guarded by
 * `referral_code IS NULL`). Retries on the (astronomically rare) unique collision.
 */
export async function generateReferralCode(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = randomCode();
    const { data, error } = await supabase
      .from('users')
      .update({ referral_code: code, updated_at: new Date().toISOString() })
      .eq('id', userId)
      .is('referral_code', null)
      .select('referral_code');

    if (error) {
      if (error.code === PG_UNIQUE_VIOLATION) continue; // collision — new code, retry
      throw error;
    }
    if (data && data.length > 0) return (data[0] as { referral_code: string }).referral_code;

    // 0 rows updated → the user already has a code (or doesn't exist)
    const { data: existing, error: findErr } = await supabase
      .from('users')
      .select('referral_code')
      .eq('id', userId)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!existing) throw new Error(`generateReferralCode: user ${userId} not found`);
    if (existing.referral_code) return existing.referral_code as string;
    // referral_code still null and the update matched nothing — retry
  }
  throw new Error('generateReferralCode: could not generate a unique code');
}

/** Tier table, cached in Redis for 1h (it changes only via migrations). */
async function getTiers(supabase: SupabaseClient, redis: Redis): Promise<ReferralTier[]> {
  const cached = await redis.get(TIER_CACHE_KEY);
  if (cached !== null) return JSON.parse(cached) as ReferralTier[];

  const { data, error } = await supabase
    .from('referral_tiers')
    .select('min_referrals, storage_limit_gb')
    .order('min_referrals', { ascending: true });
  if (error) throw error;

  // storage_limit_gb is NUMERIC (030) — PostgREST may serialize it as a string,
  // so coerce here rather than let "2.5" reach the GB multiplication.
  const tiers = ((data ?? []) as ReferralTier[]).map((t) => ({
    min_referrals: Number(t.min_referrals),
    storage_limit_gb: Number(t.storage_limit_gb),
  }));
  await redis.set(TIER_CACHE_KEY, JSON.stringify(tiers), 'EX', TIER_CACHE_TTL_SECONDS);
  return tiers;
}

/** Storage (bytes) the tier table grants for a given referral count. */
export async function getStorageTierBytes(
  supabase: SupabaseClient,
  redis: Redis,
  referralCount: number,
): Promise<number> {
  const tiers = await getTiers(supabase, redis);
  let matched: ReferralTier | null = null;
  for (const tier of tiers) {
    if (tier.min_referrals <= referralCount) matched = tier; // sorted asc — last match wins
  }
  // Round: a fractional tier (2.5 GB) isn't a whole number of bytes — matches the
  // ROUND() the redeem_referral RPC applies when it writes storage_limit.
  return matched ? Math.round(matched.storage_limit_gb * GB) : config.DEFAULT_STORAGE_LIMIT;
}

/** Business-rule checks before a redemption (the DB constraints are the backstop). */
export async function canRedeem(
  supabase: SupabaseClient,
  referrerId: string,
  refereeId: string,
): Promise<RedeemCheck> {
  // 1. self-referral
  if (referrerId === refereeId) {
    return { ok: false, reason: 'ไม่สามารถกรอกโค้ดของตัวเองได้', reasonCode: 'self' };
  }

  const { data: users, error } = await supabase
    .from('users')
    .select('id, referred_by_id')
    .in('id', [referrerId, refereeId]);
  if (error) throw error;

  const referee = users?.find((u) => u.id === refereeId);
  const referrer = users?.find((u) => u.id === referrerId);

  // 2. referee already redeemed a code
  if (referee?.referred_by_id) {
    return { ok: false, reason: 'คุณกรอกโค้ดไปแล้ว', reasonCode: 'already_redeemed' };
  }

  // 3. chain check — A invited B, B cannot invite A back
  if (referrer?.referred_by_id === refereeId) {
    return { ok: false, reason: 'ไม่สามารถกรอกโค้ดของคนที่คุณเชิญมาได้', reasonCode: 'chain' };
  }

  return { ok: true };
}

/**
 * Redeem a referral code for `refereeId`. All mutations (referrals row, referee
 * bonus, referrer count + tier recalculation) happen atomically in the
 * redeem_referral RPC (migration 010).
 */
export async function redeemCode(
  supabase: SupabaseClient,
  redis: Redis,
  code: string,
  refereeId: string,
): Promise<RedeemResult> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return { ok: false, reason: 'ไม่พบโค้ดนี้', reasonCode: 'not_found' };

  // Codes are stored uppercase, but ilike keeps the lookup case-insensitive
  // even for rows created outside generateReferralCode.
  const { data: referrer, error: findErr } = await supabase
    .from('users')
    .select('id')
    .ilike('referral_code', normalized)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!referrer) return { ok: false, reason: 'ไม่พบโค้ดนี้', reasonCode: 'not_found' };

  const check = await canRedeem(supabase, referrer.id, refereeId);
  if (!check.ok) return { ok: false, reason: check.reason, reasonCode: check.reasonCode };

  const { data: newLimit, error: rpcErr } = await supabase.rpc('redeem_referral', {
    p_referrer_id: referrer.id,
    p_referee_id: refereeId,
    p_bonus_bytes: config.REFERRAL_BONUS_BYTES,
  });
  if (rpcErr) {
    // Raced with a concurrent redemption — the UNIQUE(referee_id) / referred_by_id
    // guards inside the RPC rejected it; nothing was committed.
    if (rpcErr.code === PG_UNIQUE_VIOLATION) {
      return { ok: false, reason: 'คุณกรอกโค้ดไปแล้ว', reasonCode: 'already_redeemed' };
    }
    throw rpcErr;
  }

  return { ok: true, referrerId: referrer.id, newStorageBytes: Number(newLimit) };
}

const REDEEM_RATE_LIMIT = 3; // attempts per user per hour
const REDEEM_RATE_WINDOW_SECONDS = 3600;

/**
 * Per-user redeem attempt limiter (the global @fastify/rate-limit is IP-keyed,
 * which authenticated code-guessing would bypass). Sliding-ish fixed window:
 * INCR + EXPIRE on first hit. Returns false when the user is over the limit.
 */
export async function checkRedeemRateLimit(redis: Redis, userId: string): Promise<boolean> {
  const key = `rl:redeem:${userId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, REDEEM_RATE_WINDOW_SECONDS);
  return count <= REDEEM_RATE_LIMIT;
}

/** Referral progress for the dashboard/bot. Lazily assigns a code to pre-migration users. */
export async function getReferralStatus(
  supabase: SupabaseClient,
  redis: Redis,
  userId: string,
): Promise<ReferralStatus> {
  const { data: user, error } = await supabase
    .from('users')
    .select('referral_code, referral_count, referred_by_id')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!user) throw new Error(`getReferralStatus: user ${userId} not found`);

  const code = (user.referral_code as string | null) ?? (await generateReferralCode(supabase, userId));
  const referralCount = (user.referral_count as number | null) ?? 0;
  const referredById = (user.referred_by_id as string | null) ?? null;

  // Overall progress toward the top tier — shared by the web bar and the LINE
  // Flex progress bar so both read the same scale. Clamped at 100: past the top
  // tier the count keeps rising but the bar just stays full.
  const overallPercent = Math.min(100, Math.round((referralCount / TOP_TIER_REFERRALS) * 100));

  const tiers = await getTiers(supabase, redis);
  let current: ReferralTier | null = null;
  let next: ReferralTier | null = null;
  for (const tier of tiers) {
    if (tier.min_referrals <= referralCount) current = tier;
    else if (!next) next = tier;
  }

  const currentTierGB = current?.storage_limit_gb ?? config.DEFAULT_STORAGE_LIMIT / GB;

  if (!next) {
    return {
      code,
      referralCount,
      currentTierGB,
      nextTierGB: null,
      neededForNext: 0,
      progressPercent: 100,
      referredById,
    };
  }

  return {
    code,
    referralCount,
    currentTierGB,
    nextTierGB: next.storage_limit_gb,
    neededForNext: next.min_referrals - referralCount,
    progressPercent: overallPercent,
    referredById,
  };
}
