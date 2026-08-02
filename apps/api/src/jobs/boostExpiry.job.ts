/**
 * Daily membership expiry sweep.
 *
 * Two jobs' worth of work in one pass, because they are the same idea — an
 * entitlement whose clock ran out:
 *
 *  1. boosts past their 30 days get released_at stamped;
 *  2. subscriptions past current_period_end are expired and the user is moved
 *     back to free (which also releases the boosts they no longer own).
 *
 * Order matters: subscriptions first, so a user who lapses tonight has their
 * boost slots reconciled by the downgrade rather than surviving until tomorrow.
 *
 * Idempotent — both halves filter on the state they are about to change, so a
 * re-run finds nothing to do.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sweepExpiredBoosts } from '../services/boost.service';
import { expireLapsedSubscriptions, type VaultPlanCache } from '../services/membership.service';

export interface BoostExpiryResult {
  subscriptionsExpired: number;
  boostsReleased: number;
}

/**
 * `redis` is injected (rather than created here) so this module stays env-free
 * and unit-testable — same shape as the diary sweeps' deps. It only busts the
 * vault premium gate's 60 s cache after a downgrade; omitting it costs at most
 * a minute of stale vault access, it does not skip the DB write.
 */
export async function runBoostExpiry(
  supabase: SupabaseClient,
  now: Date = new Date(),
  opts: { redis?: VaultPlanCache } = {},
): Promise<BoostExpiryResult> {
  const { expired } = await expireLapsedSubscriptions(supabase, now, { redis: opts.redis });
  const boostsReleased = await sweepExpiredBoosts(supabase, now);

  if (expired > 0 || boostsReleased > 0) {
    console.log(
      `[membership] expiry sweep: ${expired} subscription(s) lapsed, ${boostsReleased} boost(s) released`,
    );
  }
  return { subscriptionsExpired: expired, boostsReleased };
}
