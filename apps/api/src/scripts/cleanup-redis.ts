/**
 * One-time Redis backlog cleaner for the BullMQ queues.
 *
 * Why this exists: before the retention fixes (low `removeOnComplete`/
 * `removeOnFail` on every queue), completed job hashes accumulated with no TTL —
 * most visibly the 30-min `task-recur-sweep` repeatable, whose fired iterations
 * pile up as `bull:nookeb-task-reminders:repeat:<hash>:<ms>` keys (~48/day). The
 * code fix caps future growth; this script clears the EXISTING backlog once.
 *
 * Safe by construction:
 *   - `queue.clean()` only touches the completed/failed sets (BullMQ removes both
 *     the set entry AND the job hash, so no dangling references) — it never
 *     touches active/waiting/delayed/paused, the `meta`/`id`/`events` keys, or
 *     the repeatable CONFIG (so the live schedule keeps firing).
 *   - The explicit SCAN+DEL targets ONLY past-timestamp `repeat:<hash>:<ms>`
 *     orphans. The future-scheduled iteration (ms >= now) is left intact, so the
 *     recurring sweep's next run is never dropped.
 *
 * Run: `npm run cleanup:redis` (from apps/api). Idempotent — safe to re-run.
 */
import { Queue } from 'bullmq';
import { FILE_QUEUE, TASK_QUEUE } from '@nookeb/shared';
import { createRedis } from '../plugins/redis';

// The 30-min task-recur-sweep repeatable's key hash (from the Upstash evidence).
// Its past fired iterations are the bulk of the stale backlog.
const SWEEP_REPEAT_PREFIX = `bull:${TASK_QUEUE}:repeat:f47532c3e21037e2046a2d636d7ff04d:`;

async function cleanQueueSets(queue: Queue): Promise<number> {
  // grace 0 = eligible regardless of age; limit 1000 per type per pass.
  const completed = await queue.clean(0, 1000, 'completed');
  const failed = await queue.clean(0, 1000, 'failed');
  console.log(
    `[cleanup] ${queue.name}: removed ${completed.length} completed + ${failed.length} failed jobs`,
  );
  return completed.length + failed.length;
}

/**
 * Delete stale past-timestamp `repeat:<hash>:<ms>` orphans left over from before
 * the retention fix. Batched via pipeline (10 keys/DEL round-trip). The active
 * future iteration (ms >= now) is preserved.
 */
async function deleteStaleSweepKeys(): Promise<number> {
  const redis = createRedis();
  const now = Date.now();
  let deleted = 0;
  let batch: string[] = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const pipe = redis.pipeline();
    for (const k of batch) pipe.del(k);
    await pipe.exec();
    deleted += batch.length;
    batch = [];
  };

  const stream = redis.scanStream({ match: `${SWEEP_REPEAT_PREFIX}*`, count: 200 });
  for await (const keys of stream as AsyncIterable<string[]>) {
    for (const key of keys) {
      const ms = Number(key.slice(key.lastIndexOf(':') + 1));
      // Skip the live (future) iteration; only sweep past orphans.
      if (!Number.isFinite(ms) || ms >= now) continue;
      batch.push(key);
      if (batch.length >= 10) await flush();
    }
  }
  await flush();

  console.log(`[cleanup] deleted ${deleted} stale repeat keys (${SWEEP_REPEAT_PREFIX}*)`);
  await redis.quit();
  return deleted;
}

async function main(): Promise<void> {
  const connection = createRedis();
  const fileQueue = new Queue(FILE_QUEUE, { connection });
  const taskQueue = new Queue(TASK_QUEUE, { connection });

  let total = 0;
  total += await cleanQueueSets(fileQueue);
  total += await cleanQueueSets(taskQueue);
  total += await deleteStaleSweepKeys();

  console.log(`Deleted ${total} stale keys`);

  await fileQueue.close();
  await taskQueue.close();
  await connection.quit();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[cleanup] failed:', err);
    process.exit(1);
  });
