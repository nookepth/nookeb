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
import { DIARY_REMINDER_ENABLED } from './diaryReminder.job';
import { DIARY_ADDON_ENABLED } from '../config/plans';

export const MEMBERSHIP_QUEUE = 'nookeb-membership';

/**
 * Declared once because `removeRepeatable` matches on the repeat key — pattern,
 * timezone and jobId together. If the add and the remove ever disagreed by a
 * character, the remove would silently miss and the schedule would survive.
 */
/**
 * HOURLY, not the old daily '0 20 * * *'.
 *
 * §17 stores a per-user `notify_time` (migration 028) and the daily 20:00 cron
 * ignored it — everyone was messaged at the column's DEFAULT time, so a user
 * who chose 08:00 got their nudge twelve hours late. An hourly sweep serves
 * whoever falls in the current hour, exactly like DIARY_ADDON_CRON below, and
 * `runDiaryReminderSweep` claims the Bangkok day per user (migration 054) so
 * the finer cadence cannot double-push.
 *
 * CHANGING THIS STRING ORPHANS THE OLD SCHEDULE. `removeRepeatable` matches on
 * pattern + timezone + jobId together, so the '0 20 * * *' repeatable that a
 * previous boot registered in Redis is NOT removed by the branch below — it
 * would keep firing the daily sweep forever alongside the hourly one. That is
 * what LEGACY_DIARY_REMINDER_CRON exists to clean up; delete it only once every
 * environment has booted at least once on this version.
 */
const DIARY_REMINDER_CRON = '0 * * * *';

/** The pre-2026-08 daily pattern, removed on boot. See DIARY_REMINDER_CRON. */
const LEGACY_DIARY_REMINDER_CRON = '0 20 * * *';

/**
 * หนูเก็บความทรงจำ runs at the top of EVERY hour, because each subscriber picks
 * their own notify_time and the sweep serves whoever falls in the current
 * Bangkok hour. Declared once for the same reason as DIARY_REMINDER_CRON: the
 * add and the remove must match to the character or the remove silently misses.
 */
const DIARY_ADDON_CRON = '0 * * * *';

export type MembershipJob =
  | { type: 'quota_period_cleanup' }
  | { type: 'boost_expiry' }
  | { type: 'diary_reminder_sweep' }
  | { type: 'diary_addon_sweep' };

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

  // Hourly — the §17 diary nudge, delivered in each user's chosen hour.
  //
  // Unconditional cleanup of the OLD daily 20:00 schedule, run on every boot
  // regardless of the flag: a repeatable is keyed by its pattern, so switching
  // to the hourly pattern above does not replace it — it would sit in Redis
  // beside the new one and fire a second, whole-userbase sweep every evening.
  // A no-op once gone, and on a first-ever boot.
  await q.removeRepeatable(
    'diary_reminder_sweep',
    { pattern: LEGACY_DIARY_REMINDER_CRON, tz: BANGKOK_TZ },
    'membership-diary-reminder',
  );

  // Notifications disabled — reminder interval picker UI not shipped yet (gap #9)
  //
  // Skipping the `add` is NOT sufficient on a live deploy: a repeatable
  // registered by a previous boot lives in Redis and keeps firing regardless of
  // what this process does. So when the flag is off we actively REMOVE the
  // schedule. `removeRepeatable` is a no-op when nothing is registered, which
  // makes a first-ever boot with the flag off safe too.
  if (DIARY_REMINDER_ENABLED) {
    await q.add(
      'diary_reminder_sweep',
      { type: 'diary_reminder_sweep' },
      { repeat: { pattern: DIARY_REMINDER_CRON, tz: BANGKOK_TZ }, jobId: 'membership-diary-reminder' },
    );
  } else {
    await q.removeRepeatable(
      'diary_reminder_sweep',
      { pattern: DIARY_REMINDER_CRON, tz: BANGKOK_TZ },
      'membership-diary-reminder',
    );
  }

  // Hourly — หนูเก็บความทรงจำ (the paid add-on, migration 052). Independent of
  // DIARY_REMINDER_ENABLED above: this one ships on. Same active-removal shape,
  // and for the same reason — a repeatable registered by an earlier boot lives
  // in Redis and keeps firing no matter what this process decides.
  if (DIARY_ADDON_ENABLED) {
    await q.add(
      'diary_addon_sweep',
      { type: 'diary_addon_sweep' },
      { repeat: { pattern: DIARY_ADDON_CRON, tz: BANGKOK_TZ }, jobId: 'membership-diary-addon' },
    );
  } else {
    await q.removeRepeatable(
      'diary_addon_sweep',
      { pattern: DIARY_ADDON_CRON, tz: BANGKOK_TZ },
      'membership-diary-addon',
    );
  }
}
