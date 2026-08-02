/**
 * Membership lifecycle — plan changes, subscription state, locker allowance.
 *
 * The ONE rule this file exists to hold: `users.plan` is the single column
 * every guard reads, and `users.storage_limit` is a DERIVED mirror of
 * plans.lockerLimitBytes(). Anything that can change either — an upgrade, a
 * downgrade, a referral redemption, a lapsed subscription — must go through
 * here so the two never disagree.
 *
 * Mirroring the locker limit into users.storage_limit (rather than teaching
 * every upload path to call lockerLimitBytes) is deliberate: the existing
 * atomic RPCs `increment_personal_storage` / `increment_storage_used` already
 * enforce against that column inside a single guarded UPDATE (project rule 8).
 * Recomputing the limit in application code would mean re-implementing that
 * enforcement, racily, in several places.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  lockerLimitBytes,
  normalizePlan,
  priceOf,
  type BillingCycle,
  type Plan,
} from '../config/plans';

export interface SubscriptionRecord {
  id: string;
  user_id: string;
  plan: Exclude<Plan, 'free'>;
  billing_cycle: BillingCycle;
  price_thb: number;
  status: 'active' | 'cancelled' | 'expired';
  started_at: string;
  current_period_end: string;
  cancelled_at: string | null;
}

export interface Membership {
  plan: Plan;
  referralCount: number;
  lockerLimitBytes: number;
  storageUsed: number;
  subscription: SubscriptionRecord | null;
}

/** The user's plan plus whatever billing state backs it. */
export async function getMembership(
  supabase: SupabaseClient,
  userId: string,
): Promise<Membership> {
  const { data: user, error } = await supabase
    .from('users')
    .select('plan, referral_count, storage_used, storage_limit')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!user) throw new Error(`membership: user ${userId} not found`);

  const plan = normalizePlan(user.plan as string | null);
  const referralCount = Number((user.referral_count as number | null) ?? 0);

  const { data: sub, error: subErr } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  if (subErr) throw subErr;

  return {
    plan,
    referralCount,
    lockerLimitBytes: lockerLimitBytes(plan, referralCount),
    storageUsed: Number((user.storage_used as number | null) ?? 0),
    subscription: (sub as SubscriptionRecord | null) ?? null,
  };
}

/**
 * Recompute and persist `users.storage_limit` from the plan + referral count.
 *
 * Called after every plan change and after a referral redemption. Returns the
 * value written.
 *
 * NOTE — this deliberately overwrites, including DOWNWARD. That is the spec's
 * "apply new (lower) limit immediately". Existing files are never touched: a
 * user over the new limit simply cannot upload until they free space, which
 * falls out of the guarded RPC returning over_limit.
 *
 * This supersedes migration 030's referral_tiers ladder for the FREE plan (see
 * the gap report): the allowance is now base 1 GB + 1 GB per referral capped at
 * 4 GB, computed in code, not read from referral_tiers.
 *
 * ── THE ADMIN OVERRIDE WINS (migration 059) ─────────────────────────────────
 *
 * The written value is COALESCE(storage_limit_override, lockerLimitBytes(...)).
 * Before 059 an admin who raised storage_limit by hand had it silently reverted
 * by the next call to this function — a plan change, a referral redemption or a
 * lapsed subscription — which is precisely the bug migration 024's GREATEST()
 * guard was written for on the referral path. Folding the override in at
 * COMPUTE time makes it durable without teaching every caller about it.
 *
 * `overrideBytes` may be supplied by a caller that just wrote the column (PATCH
 * /admin/users/:id/storage-override), to avoid re-reading a value it already
 * knows and to close the window where a concurrent write is read back instead.
 * Pass `null` to mean "no override"; OMIT it to mean "read it from the row".
 */
export async function syncStorageLimit(
  supabase: SupabaseClient,
  userId: string,
  opts?: { plan?: Plan; referralCount?: number; overrideBytes?: number | null },
): Promise<number> {
  let plan = opts?.plan;
  let referralCount = opts?.referralCount;
  let override = opts?.overrideBytes;

  if (plan === undefined || referralCount === undefined || override === undefined) {
    const row = await readLimitInputs(supabase, userId);
    plan ??= normalizePlan(row.plan);
    referralCount ??= Number(row.referral_count ?? 0);
    override ??= row.storage_limit_override;
  }

  const computed = lockerLimitBytes(plan, referralCount);
  const limit = override ?? computed;
  const { error: updErr } = await supabase
    .from('users')
    .update({ storage_limit: limit })
    .eq('id', userId);
  if (updErr) throw updErr;
  return limit;
}

/**
 * The three columns syncStorageLimit computes from, read tolerantly.
 *
 * `storage_limit_override` only exists once migration 059 is applied. This
 * function is on the path of every plan change, referral redemption and nightly
 * subscription expiry, so a PostgREST "column does not exist" here would take
 * all three down for every user the moment the code deployed ahead of the
 * migration. It degrades to the pre-059 shape instead — no override, which is
 * exactly what "the column does not exist yet" means.
 *
 * The fallback costs one extra round trip, and only in the window before 059 is
 * applied. Once it is, the first select always succeeds.
 */
async function readLimitInputs(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ plan: string | null; referral_count: number | null; storage_limit_override: number | null }> {
  const withOverride = await supabase
    .from('users')
    .select('plan, referral_count, storage_limit_override')
    .eq('id', userId)
    .maybeSingle();

  if (!withOverride.error) {
    const d = withOverride.data as {
      plan?: string | null;
      referral_count?: number | null;
      storage_limit_override?: number | string | null;
    } | null;
    return {
      plan: d?.plan ?? null,
      referral_count: d?.referral_count ?? null,
      // BIGINT can arrive as a string from PostgREST once values pass 2^53;
      // 60 GB does not, but normalising here costs nothing and removes the trap.
      storage_limit_override:
        d?.storage_limit_override === null || d?.storage_limit_override === undefined
          ? null
          : Number(d.storage_limit_override),
    };
  }

  const legacy = await supabase
    .from('users')
    .select('plan, referral_count')
    .eq('id', userId)
    .maybeSingle();
  if (legacy.error) throw legacy.error;
  const d = legacy.data as { plan?: string | null; referral_count?: number | null } | null;
  return { plan: d?.plan ?? null, referral_count: d?.referral_count ?? null, storage_limit_override: null };
}

export interface ChangePlanResult {
  plan: Plan;
  previousPlan: Plan;
  lockerLimitBytes: number;
  subscription: SubscriptionRecord | null;
}

/**
 * Move a user between plans.
 *
 * Quota semantics, straight from the spec:
 *  - UPGRADE mid-month: the new (higher) limit applies immediately and `used`
 *    is NOT reset. Nothing needs doing here — consume_quota re-stamps
 *    limit_value from the current plan on the very next call, so the change is
 *    visible without rewriting a single quota row.
 *  - DOWNGRADE: the new (lower) limit applies immediately; a user already over
 *    it is blocked from new usage but keeps their data. Same mechanism.
 *
 * So this function changes exactly three things: users.plan, the subscription
 * row, and the derived storage_limit.
 *
 * `periodEnd` is when paid access lapses; for a free downgrade it is ignored.
 * There is NO payment capture here — see the gap report.
 */
export async function changePlan(
  supabase: SupabaseClient,
  userId: string,
  target: Plan,
  opts: { cycle?: BillingCycle; periodEnd?: Date } = {},
): Promise<ChangePlanResult> {
  const { data: before, error: readErr } = await supabase
    .from('users')
    .select('plan, referral_count')
    .eq('id', userId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!before) throw new Error(`membership: user ${userId} not found`);

  const previousPlan = normalizePlan(before.plan as string | null);
  const referralCount = Number((before.referral_count as number | null) ?? 0);

  // Retire any active subscription first — uq_subscriptions_active_user allows
  // only one, so this must happen before the insert, not alongside it.
  const { error: cancelErr } = await supabase
    .from('subscriptions')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('status', 'active');
  if (cancelErr) throw cancelErr;

  let subscription: SubscriptionRecord | null = null;
  if (target !== 'free') {
    const cycle: BillingCycle = opts.cycle ?? 'monthly';
    const price = priceOf(target, cycle);
    if (price === null) {
      throw new Error(`membership: ${target} is not sold on a ${cycle} cycle`);
    }
    const periodEnd =
      opts.periodEnd ??
      (() => {
        const d = new Date();
        if (cycle === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
        else d.setUTCMonth(d.getUTCMonth() + 1);
        return d;
      })();

    const { data: inserted, error: insErr } = await supabase
      .from('subscriptions')
      .insert({
        user_id: userId,
        plan: target,
        billing_cycle: cycle,
        price_thb: price,
        status: 'active',
        current_period_end: periodEnd.toISOString(),
      })
      .select('*')
      .single();
    if (insErr) throw insErr;
    subscription = inserted as SubscriptionRecord;
  }

  const { error: planErr } = await supabase
    .from('users')
    .update({ plan: target })
    .eq('id', userId);
  if (planErr) throw planErr;

  const limit = await syncStorageLimit(supabase, userId, { plan: target, referralCount });

  // Downgrading out of boost entitlement releases the slots the user no longer
  // owns. Done here rather than in a nightly job so the change is immediate and
  // a re-upgrade does not silently resurrect stale boosts.
  await reconcileBoostsForPlan(supabase, userId, target);

  return { plan: target, previousPlan, lockerLimitBytes: limit, subscription };
}

/**
 * Release boosts beyond what the (possibly new) plan allows, newest first —
 * the oldest boost is the one the user has held longest and is most likely to
 * still want. Free plans lose all of them.
 *
 * Imported lazily from boost.service to keep the dependency one-way: boosts
 * know nothing about plan changes, membership drives them.
 *
 * EXPORTED for the TIER 2 admin override (PATCH /admin/users/:id/plan), which
 * moves users.plan directly without going through changePlan() — it is an
 * override, not a purchase, so it must not fabricate a subscription row. It
 * still owes the same boost reconciliation, so it calls this rather than
 * re-deriving the rule.
 */
export async function reconcileBoostsForPlan(
  supabase: SupabaseClient,
  userId: string,
  plan: Plan,
): Promise<void> {
  const { CAPACITY_LIMITS } = await import('../config/plans');
  const { listLiveBoosts, releaseBoost } = await import('./boost.service');

  const max = CAPACITY_LIMITS.group_boosts[plan];
  const live = await listLiveBoosts(supabase, userId);
  if (live.length <= max) return;

  const excess = [...live]
    .sort((a, b) => Date.parse(b.activated_at) - Date.parse(a.activated_at))
    .slice(0, live.length - max);
  for (const b of excess) {
    await releaseBoost(supabase, userId, b.group_id);
  }
}

/**
 * Downgrade every user whose paid period has lapsed. Driven by the daily job.
 * Idempotent: a second run finds no active-but-expired rows.
 */
export async function expireLapsedSubscriptions(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<{ expired: number; userIds: string[] }> {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('id, user_id')
    .eq('status', 'active')
    .lt('current_period_end', now.toISOString());
  if (error) throw error;

  const rows = (data ?? []) as { id: string; user_id: string }[];
  const userIds: string[] = [];

  for (const row of rows) {
    const { error: expErr } = await supabase
      .from('subscriptions')
      .update({ status: 'expired' })
      .eq('id', row.id)
      .eq('status', 'active'); // no-op if another runner got there first
    if (expErr) throw expErr;

    const { error: planErr } = await supabase
      .from('users')
      .update({ plan: 'free' })
      .eq('id', row.user_id);
    if (planErr) throw planErr;

    await syncStorageLimit(supabase, row.user_id, { plan: 'free' });
    await reconcileBoostsForPlan(supabase, row.user_id, 'free');
    userIds.push(row.user_id);
  }

  return { expired: rows.length, userIds };
}
