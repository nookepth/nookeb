/**
 * BullMQ queue for membership maintenance.
 *
 * A FOURTH queue rather than jobs bolted onto the file/task queues, following
 * the project's existing rule: queues are split so their failure domains stay
 * isolated. A wedged trash purge must never stop a task reminder from firing.
 *
 * All four jobs are repeatable and idempotent — re-running any of them on the
 * same day is a no-op, which is what makes it safe for Railway to restart the
 * worker at any point in the schedule.
 */

import { Queue, type ConnectionOptions } from 'bullmq';
import { createRedis } from '../plugins/redis';
import { BANGKOK_TZ, MONTHLY_RESET_CRON } from '../config/billing-period';

export const MEMBERSHIP_QUEUE = 'nookeb-membership';

export type MembershipJob =
  | { type: 'quota_period_cleanup' }
  | { type: 'boost_expiry' }
  | { type: 'diary_reminder_sweep' };

let queue: Queue<MembershipJob> | null = null;

export function getMembershipQueue(): Queue<MembershipJob> {
  if (!queue) {
    queue = new Queue<MembershipJob>(MEMBERSHIP_QUEUE, {
      connection: createRedis() as unknown as ConnectionOptions,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        // Maintenance jobs run on a schedule; keeping settled jobs around would
        // grow the completed set forever AND — the lesson from sheets_sync —
        // a lingering settled job with a stable id silently swallows the next
        // run of that same id.
        removeOnComplete: true,
        removeOnFail: 50, // keep a short failure trail for ops
      },
    });
  }
  return queue;
}

export async function closeMembershipQueue(): Promise<void> {
  await queue?.close();
  queue = null;
}

/**
 * Register the repeatable schedule. Called once at worker boot; BullMQ
 * de-duplicates by repeat key, so a restart does not stack schedules.
 *
 * Timezones are given as IANA names, never as pre-shifted UTC cron strings —
 * "the 1st at 00:00 ICT" expressed in UTC is 17:00 on the last day of the
 * previous month, which is different for every month length.
 */
export async function scheduleMembershipJobs(): Promise<void> {
  const q = getMembershipQueue();

  // Monthly, 1st at 00:00 ICT — housekeeping only (see quotaReset.job.ts for
  // why the reset itself needs no job).
  await q.add(
    'quota_period_cleanup',
    { type: 'quota_period_cleanup' },
    {
      repeat: { pattern: MONTHLY_RESET_CRON, tz: BANGKOK_TZ },
      jobId: 'membership-quota-period-cleanup',
    },
  );

  // NOTE: there is deliberately NO trash-cleanup job here. The daily
  // `purge_deleted` repeatable in upload.worker.ts already sweeps soft-deleted
  // content in one pass; it now reads its retention window from
  // jobs/trashCleanup.job.ts so the policy is plan-aware. A second daily
  // deleter would race it over the same R2 objects for no benefit.

  // Daily 03:45 ICT — boost expiry + lapsed subscription downgrade.
  await q.add(
    'boost_expiry',
    { type: 'boost_expiry' },
    { repeat: { pattern: '45 3 * * *', tz: BANGKOK_TZ }, jobId: 'membership-boost-expiry' },
  );

  // Daily 20:00 ICT — the diary nudge goes out in the evening, when there is a
  // day worth writing about.
  await q.add(
    'diary_reminder_sweep',
    { type: 'diary_reminder_sweep' },
    { repeat: { pattern: '0 20 * * *', tz: BANGKOK_TZ }, jobId: 'membership-diary-reminder' },
  );
}
