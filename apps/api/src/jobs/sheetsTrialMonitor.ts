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
import type { SheetsTrialExpiryResult } from './sheetsTrialExpiry.job';

/** The name the heartbeat row and the watchdog agree on. Declared once. */
export const SHEETS_TRIAL_JOB_NAME = 'sheets_trial_expiry';

/**
 * Record one successful sweep. NEVER THROWS.
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
    await recordJobHeartbeat(supabase, {
      jobName: SHEETS_TRIAL_JOB_NAME,
      ok: true,
      // The whole result object: "the sweep ran" is much less useful than "the
      // sweep ran and deferred 180 of 200 users", and the second one is what an
      // ops page needs to show without inventing its own query.
      result: { ...result },
    });
  } catch (err) {
    console.warn('[sheets-trial] could not record sweep outcome:', err);
  }
}
