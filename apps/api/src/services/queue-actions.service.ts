/**
 * The TWO mutating BullMQ operations the /admin/system page may perform:
 * retry one failed job, or remove one failed job.
 *
 * Deliberately its own file. queue-stats.service.ts opens with a guarantee that
 * nothing in it mutates a queue, and that guarantee is worth more than the
 * convenience of one fewer module — a reader auditing "can the ops page break
 * the queue?" should be able to answer it by looking at one short file.
 *
 * ── The failed-state gate is the safety property ────────────────────────────
 *
 * Both operations refuse anything that is not in the `failed` set. That is not
 * a nicety:
 *
 *   * remove() on an ACTIVE job pulls the payload out from under a worker that
 *     is mid-execution. The worker finishes, tries to move the job to completed,
 *     and finds nothing — the run's side effects (an R2 upload, a LINE push, a
 *     Sheets write) have already happened with no record that they did.
 *   * retry() on a DELAYED job is the same as promoting a scheduled reminder to
 *     "now", which fires it at the wrong time. `jobId = reminder-{rowId}` makes
 *     that idempotent against duplicates but not against being early.
 *   * retry() on a COMPLETED job re-runs a handler whose idempotency guarantees
 *     (CLAUDE.md §3 rule 9) assume a RETRY, not a deliberate second run.
 *
 * A failed job, by contrast, has already burnt its attempts and settled. Both
 * operations on it are exactly what the failure list implies they are.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 *
 * Both are safe to double-fire, which matters because the admin page's buttons
 * are one click away from a double click. A missing job is reported as
 * `not_found`, and a job that is no longer failed as `not_failed`; neither is an
 * error, and the route maps them to 404/409 so the second click is told what
 * happened rather than silently repeating the first.
 */

import type { Queue } from 'bullmq';
import { resolveQueue, type QueueKey } from './queue-stats.service';

export type QueueActionResult =
  | { ok: true; state: string }
  /** No such job id on that queue (already removed, or retention evicted it). */
  | { ok: false; reason: 'not_found' }
  /** The job exists but is not in the failed set — see the gate note above. */
  | { ok: false; reason: 'not_failed'; state: string }
  /** The queue handle could not be constructed (Redis down, unconfigured). */
  | { ok: false; reason: 'queue_unavailable' }
  /** Redis or BullMQ rejected the operation itself. */
  | { ok: false; reason: 'error'; message: string };

/**
 * Fetch a job and assert it is failed. Returns the job on success so the caller
 * does not re-read it, and the same discriminated failure shape otherwise.
 */
async function loadFailedJob(
  fileQueue: Queue,
  key: QueueKey,
  jobId: string,
): Promise<{ ok: true; job: Awaited<ReturnType<Queue['getJob']>> } | Exclude<QueueActionResult, { ok: true }>> {
  const queue = resolveQueue(fileQueue, key);
  if (!queue) return { ok: false, reason: 'queue_unavailable' };

  let job: Awaited<ReturnType<Queue['getJob']>>;
  try {
    job = await queue.getJob(jobId);
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : 'unknown' };
  }
  if (!job) return { ok: false, reason: 'not_found' };

  let state: string;
  try {
    state = await job.getState();
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : 'unknown' };
  }
  if (state !== 'failed') return { ok: false, reason: 'not_failed', state };

  return { ok: true, job };
}

/**
 * Move one failed job back to waiting so a worker picks it up again.
 *
 * `retry('failed')` names the set the job is being taken FROM — BullMQ needs it
 * because the same call also serves the completed set, which this function
 * refuses to reach.
 */
export async function retryFailedJob(
  fileQueue: Queue,
  key: QueueKey,
  jobId: string,
): Promise<QueueActionResult> {
  const loaded = await loadFailedJob(fileQueue, key, jobId);
  if (!loaded.ok) return loaded;

  try {
    await loaded.job!.retry('failed');
    return { ok: true, state: 'failed' };
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : 'unknown' };
  }
}

/**
 * Delete one failed job outright.
 *
 * IRREVERSIBLE — there is no undo, and the payload is gone with it. The route
 * therefore writes the audit row (including the job's own summary) BEFORE
 * calling this, per the compensation contract in admin-audit.service.ts.
 */
export async function removeFailedJob(
  fileQueue: Queue,
  key: QueueKey,
  jobId: string,
): Promise<QueueActionResult> {
  const loaded = await loadFailedJob(fileQueue, key, jobId);
  if (!loaded.ok) return loaded;

  try {
    await loaded.job!.remove();
    return { ok: true, state: 'failed' };
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : 'unknown' };
  }
}

/**
 * A job's identifying fields, for the audit row. Read BEFORE a removal, since
 * afterwards there is nothing left to describe.
 *
 * Returns null rather than throwing — a snapshot that cannot be taken must not
 * block an admin from clearing a wedged job, and `after: null` in the audit row
 * already records that the job is gone.
 */
export async function summariseJob(
  fileQueue: Queue,
  key: QueueKey,
  jobId: string,
): Promise<{ id: string; name: string; jobType: string | null; attemptsMade: number; reason: string | null } | null> {
  const queue = resolveQueue(fileQueue, key);
  if (!queue) return null;
  try {
    const job = await queue.getJob(jobId);
    if (!job) return null;
    const data = job.data as { type?: unknown } | null;
    // First line only — the rest is a node_modules stack trace, same rule as
    // getFailedJobs (it belongs in the worker log, not in a stored payload).
    const firstLine = (job.failedReason ?? '').split('\n')[0]?.trim();
    return {
      id: String(job.id ?? jobId),
      name: job.name,
      jobType: typeof data?.type === 'string' ? data.type : null,
      attemptsMade: Number(job.attemptsMade ?? 0),
      reason: firstLine ? firstLine.slice(0, 300) : null,
    };
  } catch {
    return null;
  }
}
