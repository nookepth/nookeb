import { Queue } from 'bullmq';
import { SHEETS_QUEUE, type SheetsJob } from '@nookeb/shared';
import { createRedis } from '../plugins/redis';
import { isGoogleSheetsConfigured } from './google-sheets.service';

/**
 * Google Sheets sync queue (migration 046).
 *
 * Sync is ALWAYS queued, NEVER inline. Three reasons, in order of how much they
 * hurt when ignored: a task write must not wait on a third-party HTTP call; a
 * Google outage must not turn "สร้างงาน" into a 500; and a revoked token needs
 * retry + a recorded error, which an inline call in a route can't give.
 *
 * Retry: 3 attempts, 5-minute exponential backoff (5 → 10 → 20 min). Long on
 * purpose — the failures worth retrying here are outages and rate limits, which
 * do not clear in seconds. A token problem is NOT retried (the worker detects it
 * and stands down), because no amount of retrying fixes a revoked grant.
 */

let queue: Queue<SheetsJob> | null = null;

export function getSheetsQueue(): Queue<SheetsJob> {
  if (!queue) {
    queue = new Queue<SheetsJob>(SHEETS_QUEUE, {
      connection: createRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5 * 60_000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 2000 },
      },
    });
  }
  return queue;
}

export async function closeSheetsQueue(): Promise<void> {
  await queue?.close();
  queue = null;
}

/**
 * Queue a task for mirroring. FIRE-AND-FORGET by contract: it never throws and
 * never returns a promise the caller must handle, so a Redis hiccup can't fail
 * the task write that triggered it. A dropped sync self-heals on the task's
 * next change.
 *
 * No-ops entirely when the feature isn't configured, so every call site can be
 * unconditional — no `if (googleEnabled)` scattered through the task routes.
 *
 * De-duplication: jobId is `sheets-{taskId}-{action}`, so a burst of edits to
 * one task collapses into a single pending job (BullMQ rejects a duplicate
 * jobId while one is still queued). The handler always reads the task's CURRENT
 * state, so collapsing loses nothing.
 */
export function enqueueSheetsSync(taskId: string, action: 'upsert' | 'delete'): void {
  if (!isGoogleSheetsConfigured()) return;
  void getSheetsQueue()
    .add(
      'sheets_sync',
      { type: 'sheets_sync', taskId, action },
      { jobId: `sheets-${taskId}-${action}` },
    )
    .catch((err) => {
      console.warn(`[sheets] failed to enqueue sync for task ${taskId}:`, err);
    });
}
