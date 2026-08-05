/**
 * What the sheets-trial sweep reports about ITSELF — FIX 4.
 *
 * Kept out of sheetsTrialExpiry.job.ts on purpose. That module is env-free by
 * rule 14 and its unit tests construct `deps` without a database; the ops-alert
 * path here reads `config` (for the admin LINE id and the dashboard URL), so
 * folding it in would drag config into a module whose whole contract is that it
 * has none.
 *
 * It is also the right seam conceptually: the sweep's job is to revoke
 * credentials, and whether anybody is WATCHING it do that is a separate
 * concern with a separate failure mode (this whole file may fail and the sweep
 * must still work).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { recordJobHeartbeat } from '../services/job-heartbeat.service';
import { raiseOpsAlert, resolveOpsAlert } from '../services/ops-alert.service';
import type { SheetsTrialExpiryResult } from './sheetsTrialExpiry.job';

/** The name the heartbeat row and the watchdog agree on. Declared once. */
export const SHEETS_TRIAL_JOB_NAME = 'sheets_trial_expiry';

/** FIX 5 — the alert key for a draining backlog. */
export const BACKLOG_ALERT_KEY = 'sweep_backlog:sheets_trial_expiry';

/**
 * FIX 5 — how many CONSECUTIVE full batches before this is called a backlog.
 *
 * Three, i.e. 45 minutes of the sweep never once managing to empty its queue.
 *
 * Why a streak and not a single full batch: filling a batch is what a healthy
 * run looks like the first time a backlog appears, and it is also what every run
 * looks like during a one-off burst (a marketing push fourteen days ago lands
 * every one of those trials in the same hour). Neither needs a human. What needs
 * a human is the queue never emptying — which is what three in a row means, and
 * which is the only condition under which the 200/run cap can actually hurt
 * someone by delaying revocation indefinitely.
 */
export const BACKLOG_ALERT_AFTER_RUNS = 3;

/**
 * Record one successful sweep, and raise FIX 5's backlog signal. NEVER THROWS.
 *
 * Everything downstream of a completed sweep is observability, and observability
 * must not be able to fail the job it observes: a throw here would fail the
 * BullMQ job, and the retry would re-run a sweep that has already revoked
 * credentials and sent pushes.
 */
export async function recordSweepOutcome(
  supabase: SupabaseClient,
  result: SheetsTrialExpiryResult,
): Promise<void> {
  try {
    const { consecutiveFullBatches } = await recordJobHeartbeat(supabase, {
      jobName: SHEETS_TRIAL_JOB_NAME,
      ok: true,
      // The whole result object: "the sweep ran" is much less useful than "the
      // sweep ran and deferred 180 of 200 users", and the second one is what an
      // ops page needs to show without inventing its own query.
      result: { ...result },
      // A SKIPPED run (migration 062 unapplied) read nothing, so it is neither
      // a full batch nor evidence of an empty queue — leave the streak alone
      // rather than resetting it on no information.
      fullBatch: result.skipped ? undefined : result.atCap,
    });

    await evaluateBacklog(supabase, result, consecutiveFullBatches);
  } catch (err) {
    console.warn('[sheets-trial] could not record sweep outcome:', err);
  }
}

/**
 * FIX 5 — turn a streak of full batches into a signal.
 *
 * The cap (200/run, every 15 min) means the sweep drains at most ~19.2k
 * users/day. That ceiling is fine and the cap should stay — an uncapped run
 * would hold the concurrency-1 membership worker for an unbounded stretch and
 * starve the quota/boost/diary sweeps queued behind it. The problem was that
 * hitting the ceiling was SILENT: a backlog would simply take longer and longer
 * to drain, with expired trials keeping their Google credentials the whole time,
 * and nothing anywhere said so.
 *
 * The alert names the two remedies deliberately, because both are one-line
 * changes an on-call engineer can make immediately and neither is obvious from
 * a queue-depth number: raise `batchSize`, or raise the cron frequency
 * (SHEETS_TRIAL_EXPIRY_CRON in membership.queue.ts).
 *
 * A `null` streak means the heartbeat could not be read at all (migration 065
 * unapplied) — no signal, so no alert either way. Silence is the correct
 * response to no information; alerting on it would page about the observability
 * layer rather than the product.
 */
async function evaluateBacklog(
  supabase: SupabaseClient,
  result: SheetsTrialExpiryResult,
  consecutiveFullBatches: number | null,
): Promise<void> {
  if (consecutiveFullBatches === null) return;

  if (consecutiveFullBatches < BACKLOG_ALERT_AFTER_RUNS) {
    // Closes itself as soon as one run comes back under the cap, so the open
    // list keeps meaning "still true".
    await resolveOpsAlert(supabase, BACKLOG_ALERT_KEY);
    return;
  }

  await raiseOpsAlert(supabase, {
    key: BACKLOG_ALERT_KEY,
    severity: 'warning',
    title:
      `หนูเก็บลองงาน cleanup backlog — เต็ม batch (${result.batchSize}) ` +
      `ติดกัน ${consecutiveFullBatches} รอบ`,
    detail: {
      job: SHEETS_TRIAL_JOB_NAME,
      batchSize: result.batchSize,
      consecutiveFullBatches,
      deferred: result.deferred,
      impact: 'expired trials are queued behind the per-run cap and keep their Google credentials longer',
      remedy: 'raise batchSize, or raise SHEETS_TRIAL_EXPIRY_CRON frequency in membership.queue.ts',
    },
  });
}
