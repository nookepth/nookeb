/**
 * job_heartbeats writer/reader — FIX 4 (and the counter half of FIX 5).
 *
 * ── Why absence needed to become a positive fact ──────────────────────────
 *
 * The sheets-trial expiry sweep's only evidence that it had run was a
 * console.log at the end of a run — which is, by construction, not printed when
 * the run does not happen. "No log line" is not a signal anybody can watch for;
 * you cannot grep for absence, and no dashboard can chart it.
 *
 * So each run now RECORDS that it happened, and something else watches for that
 * record going stale (services/sweep-watchdog.ts, which deliberately runs in the
 * API process — see its header).
 *
 * ── last_success_at vs last_run_at ────────────────────────────────────────
 *
 * Two columns, because "it ran and threw every time" and "it stopped running"
 * are different incidents with the same fix window but different causes, and a
 * single timestamp cannot tell them apart. The watchdog compares
 * last_success_at — a job crashing on every attempt is exactly as useless as one
 * that is not scheduled, and must alert the same way.
 *
 * ── NEVER THROWS ──────────────────────────────────────────────────────────
 *
 * Migration 060's rule, and here it has teeth: the writer is called from inside
 * a BullMQ job handler. A throw would fail the job, BullMQ would retry it, and
 * the retry would re-run a sweep that has already revoked credentials and sent
 * pushes. Losing a heartbeat row costs a gap in a chart; failing the sweep over
 * it costs duplicate work on live third-party credentials.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface HeartbeatParams {
  /** The job's own name, e.g. 'sheets_trial_expiry'. */
  jobName: string;
  /** Did the run complete without throwing? */
  ok: boolean;
  /** The run's own result object, stored verbatim for the ops page. */
  result?: Record<string, unknown> | null;
  /**
   * FIX 5 — did this run come back holding EXACTLY its batch cap? Passing
   * `true` increments the streak; `false` resets it; omitting it leaves the
   * streak untouched (for jobs that have no cap).
   */
  fullBatch?: boolean;
  now?: Date;
}

export interface HeartbeatRow {
  job_name: string;
  last_success_at: string | null;
  last_run_at: string | null;
  consecutive_failures: number;
  consecutive_full_batches: number;
  last_result: Record<string, unknown> | null;
}

/**
 * Record one run. NEVER THROWS. Returns the streak counters the caller may want
 * to act on (FIX 5's backlog signal reads `consecutiveFullBatches`), or nulls
 * when nothing could be written.
 */
export async function recordJobHeartbeat(
  supabase: SupabaseClient,
  params: HeartbeatParams,
): Promise<{ consecutiveFailures: number | null; consecutiveFullBatches: number | null }> {
  const now = (params.now ?? new Date()).toISOString();

  try {
    // Read-then-upsert rather than an RPC: the counters are per-JOB and every
    // job here is scheduled with concurrency 1 on a single repeatable, so there
    // is exactly one writer per row and no race to lose. (This is the one place
    // in the codebase where read-modify-write is safe; storage accounting is
    // not, which is why rule 8 exists.)
    const { data: prior, error: readErr } = await supabase
      .from('job_heartbeats')
      .select('consecutive_failures, consecutive_full_batches')
      .eq('job_name', params.jobName)
      .maybeSingle();
    if (readErr) throw readErr;

    const before = (prior as {
      consecutive_failures?: number;
      consecutive_full_batches?: number;
    } | null) ?? null;

    const consecutiveFailures = params.ok ? 0 : Number(before?.consecutive_failures ?? 0) + 1;
    const priorFullBatches = Number(before?.consecutive_full_batches ?? 0);
    const consecutiveFullBatches =
      params.fullBatch === undefined
        ? priorFullBatches
        : params.fullBatch
          ? priorFullBatches + 1
          : 0;

    const { error } = await supabase.from('job_heartbeats').upsert(
      {
        job_name: params.jobName,
        last_run_at: now,
        // Advanced ONLY by a successful run. A failed run leaves the previous
        // value, which is what makes "has not succeeded since X" answerable.
        ...(params.ok ? { last_success_at: now } : {}),
        consecutive_failures: consecutiveFailures,
        consecutive_full_batches: consecutiveFullBatches,
        last_result: params.result ?? null,
        updated_at: now,
      },
      { onConflict: 'job_name' },
    );
    if (error) throw error;

    return { consecutiveFailures, consecutiveFullBatches };
  } catch (err) {
    // Migration 065 unapplied, or the DB is unhappy. Observability must never
    // break the thing it observes — see the header.
    console.warn(`[job-heartbeat] could not record ${params.jobName}:`, err);
    return { consecutiveFailures: null, consecutiveFullBatches: null };
  }
}

/** All heartbeats, for the watchdog and for /admin/system. Fail-soft to empty. */
export async function readJobHeartbeats(supabase: SupabaseClient): Promise<HeartbeatRow[]> {
  try {
    const { data, error } = await supabase
      .from('job_heartbeats')
      .select('job_name, last_success_at, last_run_at, consecutive_failures, consecutive_full_batches, last_result');
    if (error) throw error;
    return (data as HeartbeatRow[] | null) ?? [];
  } catch (err) {
    console.warn('[job-heartbeat] could not read heartbeats:', err);
    return [];
  }
}
