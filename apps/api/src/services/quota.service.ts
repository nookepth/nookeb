/**
 * Quota engine — the one place that decides whether an action is allowed.
 *
 * ENV-FREE (project rule 14): every import here is either a pure module or a
 * `import type`, which TypeScript erases. The unit tests import this file
 * directly without an .env and without a live Supabase.
 *
 * Enforcement model — RESERVE, then SETTLE.
 *
 *   The spec says "check quota BEFORE executing the action (pre-check, not
 *   post-decrement)". A pure pre-check alone is not safe under concurrency:
 *   two requests both read used=9/10 and both proceed. So the pre-check IS the
 *   reservation — `consumeQuota` performs the check and the increment inside a
 *   single locked statement (see consume_quota() in migration 051) and returns
 *   `allowed:false` without side effects when it would exceed. If the action
 *   then fails, the caller releases the reservation.
 *
 *   This is the same shape the vault upload already uses for storage bytes
 *   (incrementPersonalStorage with enforce:true, then release on failure), so
 *   there is one reservation idiom in the codebase, not two.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CAPACITY_LIMITS,
  effectiveMonthlyLimit,
  isUnlimited,
  normalizePlan,
  type AddonContext,
  type CapacityFeature,
  type MonthlyFeature,
  type Plan,
  type QuotaFeature,
} from '../config/plans';
import { currentPeriodStart, periodResetAtIso, type PeriodStart } from '../config/billing-period';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Scope key for a quota row. '' = the user's own global counter. */
export const GLOBAL_SCOPE = '';

export interface QuotaState {
  feature: QuotaFeature;
  scopeId: string;
  limit: number;
  used: number;
  /** Units left. `Infinity` for unlimited — callers render, never persist, this. */
  remaining: number;
  unlimited: boolean;
  periodStart: PeriodStart | null;
  /** ISO instant of the next reset; null for capacity limits (they never reset). */
  resetAt: string | null;
}

export interface QuotaDecision extends QuotaState {
  allowed: boolean;
}

/** The structured body the spec mandates for every quota rejection. */
export interface QuotaExceededPayload {
  error: 'QUOTA_EXCEEDED';
  feature: string;
  limit: number;
  used: number;
  reset_at: string | null;
}

export class QuotaExceededError extends Error {
  readonly payload: QuotaExceededPayload;
  readonly statusCode = 429;

  constructor(state: QuotaState) {
    super(`QUOTA_EXCEEDED: ${state.feature} ${state.used}/${state.limit}`);
    this.name = 'QuotaExceededError';
    this.payload = quotaExceededPayload(state);
  }
}

export function quotaExceededPayload(state: QuotaState): QuotaExceededPayload {
  return {
    error: 'QUOTA_EXCEEDED',
    feature: state.feature,
    limit: state.limit,
    used: state.used,
    reset_at: state.resetAt,
  };
}

// ---------------------------------------------------------------------------
// Pure decision core — unit-tested directly
// ---------------------------------------------------------------------------

/**
 * Would spending `amount` units stay within `limit`?
 *
 * Deliberate choices:
 *  - `used + amount <= limit`, so the last unit IS spendable (a 10-scan plan
 *    allows the 10th scan).
 *  - Over-limit users (post-downgrade) are blocked from NEW usage but their
 *    existing data is untouched — that is this function returning false, and
 *    nothing else. Nothing here deletes.
 *  - amount 0 is always allowed: a no-op action must not be blocked, and it is
 *    how a caller asks "may I?" without spending.
 */
export function evaluateQuota(input: {
  limit: number;
  used: number;
  amount?: number;
}): { allowed: boolean; remaining: number } {
  const amount = input.amount ?? 1;
  if (isUnlimited(input.limit)) return { allowed: true, remaining: Number.POSITIVE_INFINITY };
  const remaining = Math.max(0, input.limit - input.used);
  if (amount <= 0) return { allowed: true, remaining };
  return { allowed: input.used + amount <= input.limit, remaining };
}

function toState(args: {
  feature: QuotaFeature;
  scopeId: string;
  limit: number;
  used: number;
  periodStart: PeriodStart | null;
  now: Date;
}): QuotaState {
  const { remaining } = evaluateQuota({ limit: args.limit, used: args.used, amount: 0 });
  return {
    feature: args.feature,
    scopeId: args.scopeId,
    limit: args.limit,
    used: args.used,
    remaining,
    unlimited: isUnlimited(args.limit),
    periodStart: args.periodStart,
    resetAt: args.periodStart ? periodResetAtIso(args.now) : null,
  };
}

// ---------------------------------------------------------------------------
// Plan resolution
// ---------------------------------------------------------------------------

export interface UserPlanContext {
  userId: string;
  plan: Plan;
  referralCount: number;
}

/**
 * Read the caller's effective plan. `users.plan` is the authority — the
 * subscriptions table records billing state, but a lapsed subscription is
 * reflected by the expiry job writing users.plan back to 'free', so there is
 * exactly ONE column every guard reads.
 */
export async function resolveUserPlan(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserPlanContext> {
  const { data, error } = await supabase
    .from('users')
    .select('plan, referral_count')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return {
    userId,
    plan: normalizePlan(data?.plan as string | null | undefined),
    referralCount: Number((data?.referral_count as number | null | undefined) ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Monthly quotas
// ---------------------------------------------------------------------------

export interface QuotaArgs {
  userId: string;
  feature: MonthlyFeature;
  plan: Plan;
  /** Group LINE id for group-scoped features; omit for user-global ones. */
  scopeId?: string;
  amount?: number;
  now?: Date;
  /**
   * Add-ons the caller holds. Omitted = holds none, which is the safe default:
   * a caller that forgets to pass it enforces the bare plan limit rather than
   * silently handing out an add-on's allowance.
   */
  addons?: AddonContext;
}

/**
 * Read-only view of a monthly quota. Does NOT create the period row — a status
 * screen must not have write side effects, and a missing row simply means
 * used = 0.
 */
export async function getQuota(
  supabase: SupabaseClient,
  args: Omit<QuotaArgs, 'amount'>,
): Promise<QuotaState> {
  const now = args.now ?? new Date();
  const scopeId = args.scopeId ?? GLOBAL_SCOPE;
  const periodStart = currentPeriodStart(now);
  const limit = effectiveMonthlyLimit(args.plan, args.feature, args.addons);

  const { data, error } = await supabase
    .from('user_quotas')
    .select('used')
    .eq('user_id', args.userId)
    .eq('feature', args.feature)
    .eq('scope_id', scopeId)
    .eq('period_start', periodStart)
    .maybeSingle();
  if (error) throw error;

  return toState({
    feature: args.feature,
    scopeId,
    limit,
    used: Number((data?.used as number | null | undefined) ?? 0),
    periodStart,
    now,
  });
}

/**
 * Reserve `amount` units (default 1). This is the pre-check AND the increment,
 * atomically. Returns allowed:false — never throws — when over limit, so the
 * caller can choose the status code and copy.
 *
 * The limit passed to the RPC is recomputed from the CURRENT plan on every
 * call, which is how a mid-month upgrade takes effect immediately (and a
 * downgrade tightens immediately) without resetting `used`.
 */
export async function consumeQuota(
  supabase: SupabaseClient,
  args: QuotaArgs,
): Promise<QuotaDecision> {
  const now = args.now ?? new Date();
  const scopeId = args.scopeId ?? GLOBAL_SCOPE;
  const periodStart = currentPeriodStart(now);
  const limit = effectiveMonthlyLimit(args.plan, args.feature, args.addons);
  const amount = args.amount ?? 1;

  if (amount <= 0) {
    const state = await getQuota(supabase, args);
    return { ...state, allowed: true };
  }

  const { data, error } = await supabase.rpc('consume_quota', {
    p_user_id: args.userId,
    p_feature: args.feature,
    p_scope_id: scopeId,
    p_period_start: periodStart,
    p_limit: limit,
    p_amount: amount,
  });
  if (error) throw error;

  // RETURNS TABLE → PostgREST hands back a one-row array.
  const row = (Array.isArray(data) ? data[0] : data) as
    | { used: number | null; limit_value: number | null; allowed: boolean }
    | undefined;
  if (!row) {
    throw new Error(`consume_quota returned no row for ${args.userId}/${args.feature}`);
  }

  const state = toState({
    feature: args.feature,
    scopeId,
    limit: Number(row.limit_value ?? limit),
    used: Number(row.used ?? 0),
    periodStart,
    now,
  });
  return { ...state, allowed: Boolean(row.allowed) };
}

/**
 * Hand back units reserved for an action that did NOT happen (upload stream
 * aborted, worker job threw before producing output).
 *
 * NOT for user-initiated deletes: the spec is explicit that deleting a task
 * does not refund its quota unit. Best-effort — a failed release is logged by
 * the caller, never fatal, because the alternative is failing an already-failed
 * request.
 */
export async function releaseQuota(
  supabase: SupabaseClient,
  args: { userId: string; feature: MonthlyFeature; scopeId?: string; amount?: number; now?: Date },
): Promise<void> {
  const amount = args.amount ?? 1;
  if (amount <= 0) return;
  const { error } = await supabase.rpc('release_quota', {
    p_user_id: args.userId,
    p_feature: args.feature,
    p_scope_id: args.scopeId ?? GLOBAL_SCOPE,
    p_period_start: currentPeriodStart(args.now ?? new Date()),
    p_amount: amount,
  });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Capacity limits (vault items, boost slots)
// ---------------------------------------------------------------------------

/**
 * Capacity check against a live-row count. Unlike a monthly quota there is no
 * counter to increment — the rows themselves ARE the count — so this is a
 * genuine pre-check and the caller must treat it as advisory under concurrency
 * (two simultaneous vault uploads at 9/10 can both pass). That race is bounded
 * at +1 item and is accepted deliberately; the alternative is a table lock on
 * every upload. Boost slots, where the overshoot would be user-visible and
 * billable, use the locking claim_group_boost RPC instead.
 */
export function evaluateCapacity(args: {
  plan: Plan;
  feature: CapacityFeature;
  currentCount: number;
  amount?: number;
}): QuotaDecision {
  const limit = CAPACITY_LIMITS[args.feature][args.plan];
  const { allowed, remaining } = evaluateQuota({
    limit,
    used: args.currentCount,
    amount: args.amount ?? 1,
  });
  return {
    feature: args.feature,
    scopeId: GLOBAL_SCOPE,
    limit,
    used: args.currentCount,
    remaining,
    unlimited: isUnlimited(limit),
    periodStart: null,
    resetAt: null,
    allowed,
  };
}

/** Live (non-deleted) vault item count — the input to the vault capacity check. */
export async function countVaultFiles(
  supabase: SupabaseClient,
  userId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('vault_files')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('deleted_at', null);
  if (error) throw error;
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Status aggregation (GET /users/me/quotas)
// ---------------------------------------------------------------------------

/**
 * Every monthly counter for a user in one round trip, merged with the plan's
 * limits so features never used this month still report `used: 0` instead of
 * being missing from the response.
 */
export async function listMonthlyQuotas(
  supabase: SupabaseClient,
  args: {
    userId: string;
    plan: Plan;
    features: readonly MonthlyFeature[];
    now?: Date;
    addons?: AddonContext;
  },
): Promise<QuotaState[]> {
  const now = args.now ?? new Date();
  const periodStart = currentPeriodStart(now);

  const { data, error } = await supabase
    .from('user_quotas')
    .select('feature, scope_id, used')
    .eq('user_id', args.userId)
    .eq('period_start', periodStart)
    .in('feature', args.features as string[]);
  if (error) throw error;

  const rows = (data ?? []) as { feature: string; scope_id: string; used: number }[];
  // Group-scoped features have one row PER GROUP; the account-level view sums
  // them so "files added to groups this month" is a single number. The
  // per-group figure is what the upload path enforces against, and is fetched
  // per group by getQuota.
  const usedByFeature = new Map<string, number>();
  for (const r of rows) {
    usedByFeature.set(r.feature, (usedByFeature.get(r.feature) ?? 0) + Number(r.used ?? 0));
  }

  return args.features.map((feature) =>
    toState({
      feature,
      scopeId: GLOBAL_SCOPE,
      limit: effectiveMonthlyLimit(args.plan, feature, args.addons),
      used: usedByFeature.get(feature) ?? 0,
      periodStart,
      now,
    }),
  );
}
