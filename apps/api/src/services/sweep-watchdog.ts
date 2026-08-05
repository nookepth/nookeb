/**
 * Sweep watchdog — FIX 4.
 *
 * ── It runs in the API, and that is the entire point ──────────────────────
 *
 * The sheets-trial expiry sweep is the only thing that revokes Google
 * credentials after a trial ends, and it exists in exactly one place: a
 * 15-minute repeatable on the membership worker. If that worker is down,
 * wedged, or has lost its repeatable from Redis, nothing revokes anything —
 * and nothing says so.
 *
 * A check inside the worker cannot detect that. A dead process does not run its
 * own health check; a wedged one does not either. So this watchdog lives in the
 * API process, which is a SEPARATE Railway service with a separate lifecycle,
 * and reads the worker's heartbeat row out of Postgres. That is the only
 * arrangement in which "the worker stopped" is observable at all.
 *
 * ── Why an in-process interval rather than a queue job ────────────────────
 *
 * A repeatable on a BullMQ queue would be executed by... the worker. Same
 * problem. It also cannot be a cron, because this project has no scheduler
 * outside BullMQ. An interval in a long-lived HTTP process is the remaining
 * option, and there is precedent with the same shape and the same reasoning:
 * taskScheduler's 30-minute self-heal interval (see the long comment there on
 * why it is NOT a repeatable).
 *
 * `unref()` so a pending tick never holds the process open during shutdown.
 *
 * ── Thresholds ────────────────────────────────────────────────────────────
 *
 * The sweep runs every 15 minutes. STALE_AFTER_MS is four missed runs (one
 * hour), which is what the brief asks for and is the right order of magnitude:
 * a single missed run is a deploy, and paging on a deploy is how an alert
 * channel becomes noise. An hour of no revocations is a real, reportable gap
 * and still far inside "someone can fix this today".
 *
 * NEVER THROWS. A rejection inside a bare interval is an unhandledRejection,
 * and index.ts turns that into process.exit(1) — the watchdog killing the API
 * it was added to protect.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { readJobHeartbeats } from './job-heartbeat.service';
import { raiseOpsAlert, resolveOpsAlert } from './ops-alert.service';

/** How often the watchdog looks. Deliberately finer than the staleness window. */
const CHECK_EVERY_MS = 5 * 60 * 1000;

/** Four missed 15-minute runs. See the header. */
export const STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * Jobs that must keep running, with the grace period each is allowed.
 *
 * Only the sweeps whose absence has a CONSEQUENCE are listed. A watchdog that
 * alerts on everything is one people mute; the trial sweep earns its place
 * because not running it means holding third-party OAuth credentials we have no
 * right to hold.
 */
export const WATCHED_JOBS: { jobName: string; label: string; staleAfterMs: number }[] = [
  {
    jobName: 'sheets_trial_expiry',
    label: 'หนูเก็บลองงาน credential cleanup',
    staleAfterMs: STALE_AFTER_MS,
  },
];

export const sweepStalledKey = (jobName: string): string => `sweep_stalled:${jobName}`;

export interface WatchdogFinding {
  jobName: string;
  /** ms since the last SUCCESSFUL run, or null if it has never succeeded. */
  staleForMs: number | null;
  stalled: boolean;
  consecutiveFailures: number;
}

/**
 * One pass. Exported so it can be unit-tested without an interval and called
 * on demand from /admin/system.
 */
export async function runSweepWatchdog(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<WatchdogFinding[]> {
  const heartbeats = await readJobHeartbeats(supabase);
  const byName = new Map(heartbeats.map((h) => [h.job_name, h]));
  const findings: WatchdogFinding[] = [];

  for (const watched of WATCHED_JOBS) {
    const row = byName.get(watched.jobName);
    const lastSuccess = row?.last_success_at ? Date.parse(row.last_success_at) : null;

    // NEVER SUCCEEDED IS NOT AUTOMATICALLY AN ALERT. A brand-new deployment (or
    // one that has just applied migration 065) has no row yet, and paging about
    // that on every boot is exactly the false positive that gets a channel
    // muted. The row appears within 15 minutes of the worker's first run; if it
    // does not, the FIRST heartbeat this watchdog will ever see is still
    // missing an hour later — which is caught below only once a row exists.
    // A permanently absent row is instead visible on /admin/system, where a job
    // with no heartbeat at all renders as such.
    if (lastSuccess === null) {
      findings.push({
        jobName: watched.jobName,
        staleForMs: null,
        stalled: false,
        consecutiveFailures: row?.consecutive_failures ?? 0,
      });
      continue;
    }

    const staleForMs = now.getTime() - lastSuccess;
    const stalled = staleForMs >= watched.staleAfterMs;
    findings.push({
      jobName: watched.jobName,
      staleForMs,
      stalled,
      consecutiveFailures: row?.consecutive_failures ?? 0,
    });

    const key = sweepStalledKey(watched.jobName);
    if (stalled) {
      await raiseOpsAlert(supabase, {
        key,
        severity: 'critical',
        title: `${watched.label} หยุดทำงาน — ไม่มีรอบที่สำเร็จมา ${Math.round(staleForMs / 60000)} นาที`,
        detail: {
          job: watched.jobName,
          lastSuccessAt: row?.last_success_at ?? null,
          consecutiveFailures: row?.consecutive_failures ?? 0,
          // The consequence, spelled out — an alert that only says "job late"
          // makes the reader work out why they should care at 3am.
          impact: 'expired trials keep their Google credentials until this runs again',
        },
      });
    } else {
      // Closes itself on recovery, so the open-alert list means "still broken".
      await resolveOpsAlert(supabase, key);
    }
  }

  return findings;
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start the periodic check. Idempotent; safe to call once at boot.
 *
 * The first pass is deliberately DELAYED by one interval rather than run
 * immediately: on a cold start the worker may not have had a chance to run yet,
 * and an alert fired during the first second of a deploy is a false positive
 * about the deploy itself.
 */
export function startSweepWatchdog(supabase: SupabaseClient): void {
  if (timer) return;
  timer = setInterval(() => {
    void runSweepWatchdog(supabase).catch((err) => {
      // runSweepWatchdog's own dependencies never throw, but a bug here must
      // still not become an unhandledRejection — index.ts exits(1) on those.
      console.error('[sweep-watchdog] check failed:', err);
    });
  }, CHECK_EVERY_MS);
  // Never hold the process open for a pending tick.
  timer.unref();
}

export function stopSweepWatchdog(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
