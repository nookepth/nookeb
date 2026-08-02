/**
 * Read-only BullMQ introspection for the /admin/system page.
 *
 * Every function here is OBSERVATION ONLY. Nothing in this module retries,
 * promotes, drains or removes a job. TIER 2 added exactly two mutations
 * (retry / remove a single failed job) and they live in their own file,
 * services/queue-actions.service.ts, so this module's read-only guarantee still
 * holds by inspection. The one thing shared across the boundary is
 * `resolveQueue` below — resolving a handle is still observation.
 *
 * Queue handles: the file queue is the Fastify decoration installed by
 * plugins/bullmq.ts (already connected, already closed on app shutdown); the
 * other three come from their own lazy accessors. Those accessors open a Redis
 * connection on first call and keep it for the process lifetime — deliberate,
 * and the same connection the API already opens whenever it enqueues a task
 * reminder or a sheets sync. The membership queue is the only one the API would
 * not otherwise hold open; one idle ioredis connection is an acceptable price
 * for the page, and it is the same handle jobs/membership.queue.ts hands to
 * every other caller, never a second one.
 *
 * FAIL SOFT is the contract. Redis being down is exactly when an admin opens
 * this page, so a dead connection must render "unknown" rather than throw: each
 * queue is probed independently and a failure becomes `error` on that queue's
 * row, leaving the others readable.
 */

import type { Queue } from 'bullmq';
import { getTaskQueue } from './taskScheduler';
import { getSheetsQueue } from './sheetsQueue';
import { getMembershipQueue } from '../jobs/membership.queue';

/** The four queues, by the key the API and the page agree on. */
export const QUEUE_KEYS = ['file', 'task', 'sheets', 'membership'] as const;
export type QueueKey = (typeof QUEUE_KEYS)[number];

export interface QueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

export interface QueueStat extends QueueCounts {
  key: QueueKey;
  name: string;
  /** `false` when the counts could not be read (Redis down, queue not constructed). */
  ok: boolean;
  /** Present only when ok === false. Generic — never the raw driver message. */
  error: string | null;
}

export interface FailedJobSummary {
  id: string;
  name: string;
  /** The job's own `type` discriminator when the payload carries one. */
  jobType: string | null;
  attemptsMade: number;
  /** First line of the stack only — enough to triage, no leaked internals below it. */
  reason: string | null;
  failedAt: string | null;
  timestamp: string | null;
}

const EMPTY_COUNTS: QueueCounts = {
  waiting: 0,
  active: 0,
  completed: 0,
  failed: 0,
  delayed: 0,
  paused: 0,
};

/**
 * Resolve every queue handle. Each lazy accessor is wrapped because
 * constructing a Queue builds a Redis connection, and `createRedis()` throws on
 * a malformed or unreachable REDIS_URL. A queue we cannot get a handle for is
 * reported as `ok: false`, never thrown.
 *
 * Note that the sheets queue is constructed here even when Google is
 * unconfigured — the `isGoogleSheetsConfigured()` guard lives in the enqueue
 * helpers, not the accessor, so the handle always resolves. Its counts are then
 * legitimately all-zero, which is the correct thing to show for a feature that
 * is off.
 */
function resolveQueues(fileQueue: Queue): { key: QueueKey; queue: Queue | null }[] {
  const lazy = (get: () => Queue): Queue | null => {
    try {
      return get();
    } catch {
      return null;
    }
  };
  return [
    { key: 'file', queue: fileQueue ?? null },
    { key: 'task', queue: lazy(() => getTaskQueue() as unknown as Queue) },
    { key: 'sheets', queue: lazy(() => getSheetsQueue() as unknown as Queue) },
    { key: 'membership', queue: lazy(() => getMembershipQueue() as unknown as Queue) },
  ];
}

/**
 * Depth + failure counts for all four queues, probed in parallel.
 *
 * `getJobCounts()` is a single Redis pipeline per queue, so this is four round
 * trips regardless of how many jobs exist — safe to poll on a 10 s timer, which
 * is what the page does.
 */
/**
 * One queue handle by key, or null when it cannot be constructed.
 *
 * Exported for services/queue-actions.service.ts so the two admin surfaces
 * agree on exactly which four queues exist and how each handle is obtained —
 * a second resolver would be a second place for the sheets queue's
 * lazily-constructed handle to be got wrong.
 */
export function resolveQueue(fileQueue: Queue, key: QueueKey): Queue | null {
  return resolveQueues(fileQueue).find((e) => e.key === key)?.queue ?? null;
}

export async function getQueueStats(fileQueue: Queue): Promise<QueueStat[]> {
  const entries = resolveQueues(fileQueue);

  return Promise.all(
    entries.map(async ({ key, queue }): Promise<QueueStat> => {
      if (!queue) {
        return {
          key,
          name: key,
          ...EMPTY_COUNTS,
          ok: false,
          error: 'queue unavailable',
        };
      }
      try {
        const counts = await queue.getJobCounts(
          'waiting',
          'active',
          'completed',
          'failed',
          'delayed',
          'paused',
        );
        return {
          key,
          name: queue.name,
          waiting: Number(counts.waiting ?? 0),
          active: Number(counts.active ?? 0),
          completed: Number(counts.completed ?? 0),
          failed: Number(counts.failed ?? 0),
          delayed: Number(counts.delayed ?? 0),
          paused: Number(counts.paused ?? 0),
          ok: true,
          error: null,
        };
      } catch {
        return { key, name: queue.name, ...EMPTY_COUNTS, ok: false, error: 'unreachable' };
      }
    }),
  );
}

/**
 * The 20 most recent failed jobs on one queue.
 *
 * Bounded at 20 by `getFailed(0, 19)` — an unbounded read of a queue that has
 * been failing for a week would pull thousands of payloads through the API for
 * a table nobody scrolls. `removeOnFail: { count: 500 }` already caps what
 * Redis retains, so 20 is a page, not a truncation of the truth.
 *
 * `failedReason` is truncated to its FIRST LINE: the rest is a stack trace
 * through node_modules, which belongs in the worker log, not in an HTTP
 * response. Returns [] on any error — same fail-soft contract as getQueueStats.
 */
export async function getFailedJobs(
  fileQueue: Queue,
  key: QueueKey,
): Promise<FailedJobSummary[]> {
  const queue = resolveQueue(fileQueue, key);
  if (!queue) return [];

  try {
    const jobs = await queue.getFailed(0, 19);
    return jobs.map((job): FailedJobSummary => {
      const data = job.data as { type?: unknown } | null;
      const firstLine = (job.failedReason ?? '').split('\n')[0]?.trim();
      return {
        id: String(job.id ?? ''),
        name: job.name,
        jobType: typeof data?.type === 'string' ? data.type : null,
        attemptsMade: Number(job.attemptsMade ?? 0),
        reason: firstLine ? firstLine.slice(0, 300) : null,
        failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
        timestamp: job.timestamp ? new Date(job.timestamp).toISOString() : null,
      };
    });
  } catch {
    return [];
  }
}
