/**
 * บูธ (Group Boost) — §3 of the membership matrix.
 *
 * A boost marks a group as high-priority for its owner. FREE has no slots, PRO
 * has 1, PREMIUM has 3, and each boost runs for 30 days from activation.
 *
 * Two invariants, both enforced in the DB rather than here:
 *  - a user can never hold more live boosts than their plan allows
 *    (claim_group_boost locks the users row, counts, then inserts);
 *  - a (user, group) pair can have at most one live boost
 *    (uq_group_boost_live partial unique index).
 *
 * "Changing boost target: user must un-boost current group first (or replace if
 * under limit)" is implemented literally: `boostGroup` refuses with
 * BOOST_LIMIT_REACHED when the slots are full and names the groups occupying
 * them, so the caller can offer a swap. `replaceBoost` is the one-call swap.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { BOOST_DURATION_DAYS, CAPACITY_LIMITS, type Plan } from '../config/plans';

export interface BoostRecord {
  id: string;
  user_id: string;
  group_id: string;
  activated_at: string;
  expires_at: string;
  released_at: string | null;
}

export type BoostResult =
  | { ok: true; boost: BoostRecord; alreadyBoosted: boolean }
  | {
      ok: false;
      code: 'BOOST_NOT_AVAILABLE' | 'BOOST_LIMIT_REACHED';
      limit: number;
      used: number;
      liveGroupIds: string[];
    };

/**
 * Every boost the user currently holds: not released, not expired.
 *
 * Expiry is evaluated against NOW at read time rather than trusting the daily
 * sweep, so a boost is never treated as live for even a minute past its end.
 */
export async function listLiveBoosts(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date(),
): Promise<BoostRecord[]> {
  const { data, error } = await supabase
    .from('user_group_boosts')
    .select('*')
    .eq('user_id', userId)
    .is('released_at', null)
    .gt('expires_at', now.toISOString())
    .order('activated_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as BoostRecord[];
}

/** Is this group boosted by anyone right now? Drives the visibility/priority flag. */
export async function isGroupBoosted(
  supabase: SupabaseClient,
  groupId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const { count, error } = await supabase
    .from('user_group_boosts')
    .select('id', { count: 'exact', head: true })
    .eq('group_id', groupId)
    .is('released_at', null)
    .gt('expires_at', now.toISOString());
  if (error) throw error;
  return (count ?? 0) > 0;
}

/**
 * Activate a boost. Atomic against the plan's slot count — see
 * claim_group_boost in migration 051.
 *
 * Re-boosting an already-boosted group is a no-op that returns the existing
 * row with `alreadyBoosted: true`; it does NOT extend the expiry, because
 * silently renewing on a double tap would make the 30-day window unpredictable.
 */
export async function boostGroup(
  supabase: SupabaseClient,
  args: { userId: string; groupId: string; plan: Plan },
): Promise<BoostResult> {
  const max = CAPACITY_LIMITS.group_boosts[args.plan];
  const live = await listLiveBoosts(supabase, args.userId);

  if (max <= 0) {
    return {
      ok: false,
      code: 'BOOST_NOT_AVAILABLE',
      limit: 0,
      used: live.length,
      liveGroupIds: live.map((b) => b.group_id),
    };
  }

  const { data, error } = await supabase.rpc('claim_group_boost', {
    p_user_id: args.userId,
    p_group_id: args.groupId,
    p_max: max,
    p_days: BOOST_DURATION_DAYS,
  });
  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as
    | { id: string; group_id: string; activated_at: string; expires_at: string }
    | undefined;

  if (!row) {
    // The RPC returns zero rows only when the slots are full.
    return {
      ok: false,
      code: 'BOOST_LIMIT_REACHED',
      limit: max,
      used: live.length,
      liveGroupIds: live.map((b) => b.group_id),
    };
  }

  return {
    ok: true,
    alreadyBoosted: live.some((b) => b.group_id === args.groupId),
    boost: {
      id: row.id,
      user_id: args.userId,
      group_id: row.group_id,
      activated_at: row.activated_at,
      expires_at: row.expires_at,
      released_at: null,
    },
  };
}

/**
 * Un-boost. Returns false when there was nothing live to release, so the caller
 * can tell "freed a slot" from "nothing to do" without a second query.
 */
export async function releaseBoost(
  supabase: SupabaseClient,
  userId: string,
  groupId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('user_group_boosts')
    .update({ released_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('group_id', groupId)
    .is('released_at', null)
    .select('id');
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * Swap the boost from one group to another in a single call — the "replace"
 * half of the UX rule. Releases first so the slot is free before the claim,
 * and restores the old boost if the claim then fails, so a failed swap never
 * leaves the user with fewer boosts than they started with.
 */
export async function replaceBoost(
  supabase: SupabaseClient,
  args: { userId: string; fromGroupId: string; toGroupId: string; plan: Plan },
): Promise<BoostResult> {
  const released = await releaseBoost(supabase, args.userId, args.fromGroupId);

  const result = await boostGroup(supabase, {
    userId: args.userId,
    groupId: args.toGroupId,
    plan: args.plan,
  });

  if (!result.ok && released) {
    // Roll back: re-claim the group we just freed. Best-effort — if this also
    // fails the user has lost a slot they can re-claim manually, which is
    // better than throwing away the error that actually explains the failure.
    await boostGroup(supabase, {
      userId: args.userId,
      groupId: args.fromGroupId,
      plan: args.plan,
    }).catch(() => undefined);
  }

  return result;
}

/**
 * Stamp released_at on boosts whose 30 days are up. Purely hygienic — every
 * read already filters on expires_at — but it keeps the partial unique index
 * from blocking a re-boost of the same group, and makes the table honest.
 */
export async function sweepExpiredBoosts(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<number> {
  const { data, error } = await supabase
    .from('user_group_boosts')
    .update({ released_at: now.toISOString() })
    .is('released_at', null)
    .lte('expires_at', now.toISOString())
    .select('id');
  if (error) throw error;
  return (data ?? []).length;
}

export interface BoostStatus {
  plan: Plan;
  limit: number;
  used: number;
  available: number;
  durationDays: number;
  boosts: { groupId: string; activatedAt: string; expiresAt: string }[];
}

/** Everything the group picker needs to render and enforce its checkbox max. */
export async function getBoostStatus(
  supabase: SupabaseClient,
  userId: string,
  plan: Plan,
): Promise<BoostStatus> {
  const live = await listLiveBoosts(supabase, userId);
  const limit = CAPACITY_LIMITS.group_boosts[plan];
  return {
    plan,
    limit,
    used: live.length,
    available: Math.max(0, limit - live.length),
    durationDays: BOOST_DURATION_DAYS,
    boosts: live.map((b) => ({
      groupId: b.group_id,
      activatedAt: b.activated_at,
      expiresAt: b.expires_at,
    })),
  };
}
