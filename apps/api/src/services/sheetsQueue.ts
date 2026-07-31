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
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
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
export function enqueueHistoricalSync(userId: string): void {
  if (!isGoogleSheetsConfigured()) return;
  void getSheetsQueue()
    .add(
      'sheets_historical',
      { type: 'sheets_historical', userId },
      // One pending backfill per user. A double-tap of the dashboard button (or
      // a manual press racing the automatic first-connect run) collapses into
      // the same job instead of two workers appending the same rows — the
      // duplicate guard would catch that anyway, but only after both had read
      // and written the sheet.
      {
        jobId: `sheets-historical-${userId}`,
        // The stable jobId is what makes the de-duplication work, so the job
        // MUST be removed the moment it settles: BullMQ rejects an add whose
        // jobId still exists in the completed/failed set, which with the
        // queue's default retention would silently swallow every later press of
        // the button. Nothing here is worth keeping — the outcome is stamped in
        // the sheet and the failure is in the logs.
        removeOnComplete: true,
        removeOnFail: true,
      },
    )
    .catch((err) => {
      console.warn(`[sheets] failed to enqueue historical sync for user ${userId}:`, err);
    });
}

/**
 * Job options for sheets_sync, exported for the regression test.
 *
 * removeOnComplete/removeOnFail MUST stay true here for the same reason they
 * are true on the historical job above: BullMQ rejects an add whose jobId
 * still exists in the COMPLETED (or failed) set, and this queue's default
 * retention keeps the last 100 completed jobs around. With retention, the
 * create-sync's `sheets-{taskId}-upsert` job sat in the completed set and
 * silently swallowed EVERY later status change for that task — รับทราบ,
 * ส่งงาน, ตีกลับ, เสร็จแล้ว all reached the DB but never the sheet. Removing
 * the job the moment it settles keeps the de-duplication window to
 * waiting/active only, which is the only window where collapsing is safe.
 *
 * (Residual, self-healing race: a change landing while the job is ACTIVE —
 * after the worker already read the task — is collapsed into it and syncs on
 * the task's next change. That window is seconds; the swallowed window was
 * indefinite.)
 */
export function sheetsSyncJobOptions(taskId: string, action: 'upsert' | 'delete') {
  return {
    jobId: `sheets-${taskId}-${action}`,
    removeOnComplete: true,
    removeOnFail: true,
  } as const;
}

export function enqueueSheetsSync(taskId: string, action: 'upsert' | 'delete'): void {
  if (!isGoogleSheetsConfigured()) return;
  void getSheetsQueue()
    .add(
      'sheets_sync',
      { type: 'sheets_sync', taskId, action },
      sheetsSyncJobOptions(taskId, action),
    )
    .catch((err) => {
      console.warn(`[sheets] failed to enqueue sync for task ${taskId}:`, err);
    });
}
