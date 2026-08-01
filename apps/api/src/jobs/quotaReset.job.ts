/**
 * Monthly quota reset — 1st of the month, 00:00 ICT.
 *
 * READ THIS BEFORE "FIXING" THE JOB TO ZERO THE COUNTERS.
 *
 * The reset is STRUCTURAL, not a mutation. Every `user_quotas` row is keyed by
 * `period_start` (the Bangkok month), and `consumeQuota` always looks up the
 * CURRENT period. At 00:00 ICT on the 1st the lookup key changes, no row exists
 * for the new period yet, and the first call creates one at used = 0.
 *
 * The reset therefore cannot fail, cannot run late, cannot double-run, and does
 * not depend on this worker being alive at midnight. A job that UPDATE-ed
 * `used = 0` would have every one of those failure modes: miss a run and a
 * paying user is locked out for a month.
 *
 * What this job actually does is housekeeping — delete rows from periods nobody
 * will read again, so the table does not grow without bound (one row per user
 * per feature per month, plus one per user per GROUP per month for group_files,
 * which is the row count that actually accumulates).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { currentPeriodStart, previousPeriodStart } from '../config/billing-period';

/**
 * How many completed periods to keep. Kept deliberately generous: the rows are
 * tiny, and having last quarter's usage is what makes "why was I blocked in
 * August?" answerable in a support ticket.
 */
export const QUOTA_HISTORY_PERIODS = 6;

export interface QuotaCleanupResult {
  cutoffPeriod: string;
  deleted: number;
}

/**
 * Delete quota rows older than the retention window.
 *
 * `apply=false` reports what would go, matching the convention the purge script
 * already uses (dry-run by default is how that script avoids accidents).
 */
export async function cleanupOldQuotaPeriods(
  supabase: SupabaseClient,
  opts: { apply: boolean; now?: Date; keepPeriods?: number } = { apply: false },
): Promise<QuotaCleanupResult> {
  const now = opts.now ?? new Date();
  const keep = opts.keepPeriods ?? QUOTA_HISTORY_PERIODS;

  // Walk back `keep` months from the current period to find the cutoff.
  let cutoff = currentPeriodStart(now);
  for (let i = 0; i < keep; i += 1) cutoff = previousPeriodStart(cutoff);

  if (!opts.apply) {
    const { count, error } = await supabase
      .from('user_quotas')
      .select('id', { count: 'exact', head: true })
      .lt('period_start', cutoff);
    if (error) throw error;
    return { cutoffPeriod: cutoff, deleted: count ?? 0 };
  }

  const { data, error } = await supabase
    .from('user_quotas')
    .delete()
    .lt('period_start', cutoff)
    .select('id');
  if (error) throw error;
  return { cutoffPeriod: cutoff, deleted: (data ?? []).length };
}

/** The BullMQ handler. */
export async function runQuotaPeriodCleanup(supabase: SupabaseClient): Promise<QuotaCleanupResult> {
  const result = await cleanupOldQuotaPeriods(supabase, { apply: true });
  console.log(
    `[membership] quota period cleanup: removed ${result.deleted} rows older than ${result.cutoffPeriod}`,
  );
  return result;
}
