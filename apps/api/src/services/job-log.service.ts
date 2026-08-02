/**
 * job_log writer — throughput history for the four BullMQ queues (migration 060).
 *
 * WHY BULLMQ'S OWN NUMBERS DO NOT ANSWER THIS. Every queue in this product
 * settles jobs with a removeOn* policy: the file queue keeps a short window,
 * the membership and sheets queues remove immediately — and sheets_sync MUST,
 * because a settled job whose stable jobId lingers in the completed set
 * silently swallows every later sync for that task. So
 * `Queue.getJobCounts().completed` measures the EVICTION POLICY, not the work,
 * and a job that succeeded an hour ago has left no trace anywhere.
 *
 * That makes two ordinary questions unanswerable without this table:
 * "is the worker keeping up?" and "did add_scan_page get slower after the
 * OpenCV change?" — the first is a rate, the second is a distribution, and
 * neither can be read off a gauge.
 *
 * ── NEVER THROWS, and here that is not a nicety ────────────────────────────
 *
 * The callers are BullMQ 'completed'/'failed' EVENT LISTENERS. A rejected
 * promise inside one of those is an unhandledRejection, and workers/index.ts
 * turns unhandledRejection into process.exit(1) on purpose. An unavailable
 * job_log table would therefore restart-loop the worker — the observability
 * layer taking down the thing it observes, which is the exact failure this
 * project's fail-open rules exist to prevent.
 *
 * So every path is caught. A lost row costs one point on a chart.
 *
 * ── FIRE AND FORGET ────────────────────────────────────────────────────────
 *
 * Callers do not await this (a listener is sync). That is safe precisely
 * because it cannot reject: `void writeJobLog(...)` leaves no unhandled
 * rejection behind.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';

export interface WriteJobLogParams {
  /** Service-role client. Omitted → this module's lazy singleton. */
  supabase?: SupabaseClient | null;
  /** Queue key as the admin page knows it: 'file' | 'task' | 'sheets' | 'membership'. */
  queue: string;
  /** The job's own `type` discriminator ('upload_batch', 'task_reminder', …). */
  jobName: string;
  status: 'completed' | 'failed';
  /** finishedOn - processedOn. Omitted when the job never entered processing. */
  durationMs?: number;
}

let lazyClient: SupabaseClient | null = null;

function db(supplied?: SupabaseClient | null): SupabaseClient {
  if (supplied) return supplied;
  if (!lazyClient) {
    lazyClient = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return lazyClient;
}

/**
 * Record one settled job. NEVER THROWS — see the header.
 *
 * `durationMs` is written as NULL, never 0, when it is absent or nonsensical.
 * A fabricated 0 would claim an instantaneous job and drag every average toward
 * a value nothing ever took — the same rule the Sheets workspace's blank
 * performance cells follow. Non-integers are floored because the column is INT;
 * negatives (a clock adjustment between processedOn and finishedOn) are dropped
 * rather than clamped to 0, for the same reason.
 */
export async function writeJobLog(params: WriteJobLogParams): Promise<void> {
  try {
    const raw = params.durationMs;
    const duration =
      typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : null;

    const { error } = await db(params.supabase).from('job_log').insert({
      queue: params.queue,
      job_name: params.jobName,
      status: params.status,
      duration_ms: duration,
    });
    if (error) {
      console.warn('[job-log] insert failed — row lost', {
        queue: params.queue,
        jobName: params.jobName,
        error,
      });
    }
  } catch (err) {
    console.warn('[job-log] insert threw — row lost', {
      queue: params.queue,
      jobName: params.jobName,
      err,
    });
  }
}
