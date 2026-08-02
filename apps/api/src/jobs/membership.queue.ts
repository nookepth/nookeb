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
import { getFlag } from '../services/feature-flags.service';

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

/**
 * หนูเก็บลองงาน (migration 062) — every 15 minutes.
 *
 * NOT the cutoff. Access ends the instant `sheets_trial_expires_at` passes,
 * because every Sheets route and both worker paths compare it at request time
 * (see services/sheets-trial.service.ts). This schedule only governs how
 * quickly the Google grant is revoked and the stored credential destroyed
 * afterwards — so the cadence is a cleanup latency, never a grace period.
 *
 * Unconditional: there is no feature flag. The sweep's only job is to destroy
 * credentials that have already stopped being usable, and a switch that could
 * stop it doing that would be a switch for leaving third-party tokens alive.
 *
 * Same declare-once discipline as the crons above — `removeRepeatable` matches
 * on pattern + timezone + jobId together.
 */
const SHEETS_TRIAL_EXPIRY_CRON = '*/15 * * * *';

export type MembershipJob =
  | { type: 'quota_period_cleanup' }
  | { type: 'boost_expiry' }
  | { type: 'diary_reminder_sweep' }
  | { type: 'diary_addon_sweep' }
  | { type: 'sheets_trial_expiry' };

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

  // The §17 nudge, gated by the `diary_reminder_enabled` flag (059 + 061). The
  // flag used to be a hard-coded constant read at import; it is now a DB row, so
  // this boot-time registration is only ever the STARTING position —
  // toggleDiaryReminderSchedule below is what keeps Redis in step afterwards.
  await toggleDiaryReminderSchedule(await getFlag('diary_reminder_enabled', false));

  // Hourly — หนูเก็บความทรงจำ (the paid add-on, migration 052). Independent of
  // the §17 nudge above. Same active-removal shape, and for the same reason —
  // a repeatable registered by an earlier boot lives in Redis and keeps firing
  // no matter what this process decides.
  if (await getFlag('diary_addon_enabled', true)) {
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

  // Every 15 minutes — หนูเก็บลองงาน credential cleanup (migration 062).
  // Unflagged and unconditional; see SHEETS_TRIAL_EXPIRY_CRON for why.
  await q.add(
    'sheets_trial_expiry',
    { type: 'sheets_trial_expiry' },
    {
      repeat: { pattern: SHEETS_TRIAL_EXPIRY_CRON, tz: BANGKOK_TZ },
      jobId: 'membership-sheets-trial-expiry',
    },
  );
}

/**
 * Register or remove the §17 diary-reminder repeatable to match the flag.
 *
 * ── Why a DB flag alone is NOT enough ──────────────────────────────────────
 *
 * Every other TIER 3 flag is read at the moment it matters, so flipping the row
 * is the whole change. This one is different: the sweep does not run because
 * something checks a flag, it runs because a REPEATABLE JOB EXISTS IN REDIS.
 * That job was registered at worker boot and it keeps firing on its cron
 * forever, entirely indifferent to what `system_settings` now says. Flipping the
 * row alone would therefore:
 *
 *   OFF → ON   change nothing at all. No schedule exists, so nothing fires, and
 *              the admin's switch appears simply not to work — until the next
 *              worker restart, hours or days later, silently turns it on.
 *   ON → OFF   half-work. The sweep would still fire hourly and would still hit
 *              the database on every run; it would only stand down at the
 *              `deps.enabled` guard inside runDiaryReminderSweep. Correct
 *              behaviour, wasted work, and a queue depth that lies.
 *
 * So setFlag('diary_reminder_enabled') calls this, and Redis is brought into
 * agreement with the row in the same request.
 *
 * ── This runs in the API process, and that is fine ────────────────────────
 *
 * The admin endpoint lives in the API; the sweep runs in the worker. A
 * repeatable is not worker state — it is a sorted-set entry in Redis, which
 * both processes reach through the same queue handle. The API already holds one
 * (queue-stats.service constructs it for /admin/system/queues). The worker
 * notices on its next poll; nothing needs restarting.
 *
 * ── Remove-then-add, unconditionally ──────────────────────────────────────
 *
 * The remove runs on BOTH paths rather than only the disable path, so this is
 * idempotent in both directions and self-healing: calling it with `true` when a
 * schedule already exists re-registers the identical repeat key, and BullMQ
 * de-duplicates. `removeRepeatable` is a no-op when nothing is registered.
 *
 * It matches on pattern + timezone + jobId together, which is exactly why
 * DIARY_REMINDER_CRON is a single declared constant — an add and a remove that
 * disagreed by one character would leave an orphan schedule firing forever.
 */
export async function toggleDiaryReminderSchedule(enabled: boolean): Promise<void> {
  const q = getMembershipQueue();

  await q.removeRepeatable(
    'diary_reminder_sweep',
    { pattern: DIARY_REMINDER_CRON, tz: BANGKOK_TZ },
    'membership-diary-reminder',
  );

  if (enabled) {
    await q.add(
      'diary_reminder_sweep',
      { type: 'diary_reminder_sweep' },
      { repeat: { pattern: DIARY_REMINDER_CRON, tz: BANGKOK_TZ }, jobId: 'membership-diary-reminder' },
    );
  }
}
