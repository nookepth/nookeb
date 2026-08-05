/**
 * BullMQ worker for the membership maintenance queue.
 *
 * Runs inside the existing worker process (workers/index.ts) alongside the
 * file, task-reminder and sheets workers — same process, separate queues, which
 * is the project's established shape.
 */

import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import { createClient } from '@supabase/supabase-js';
import { config } from '../config';
import { createRedis } from '../plugins/redis';
import { pushMessage } from '../services/line.service';
import { getFlag } from '../services/feature-flags.service';
import { revokeRefreshToken } from '../services/google-sheets.service';
import { getSheetsQueue } from '../services/sheetsQueue';
import { MEMBERSHIP_QUEUE, type MembershipJob } from './membership.queue';
import { runQuotaPeriodCleanup } from './quotaReset.job';
import { runBoostExpiry } from './boostExpiry.job';
import { runDiaryAddonSweep, runDiaryReminderSweep } from './diaryReminder.job';
import { runSheetsTrialExpiry } from './sheetsTrialExpiry.job';
import { runGoogleRevokeRetry } from './googleRevokeRetry.job';

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

export function createMembershipWorker(): Worker<MembershipJob> {
  const worker = new Worker<MembershipJob>(
    MEMBERSHIP_QUEUE,
    async (job: Job<MembershipJob>) => {
      switch (job.data.type) {
        case 'quota_period_cleanup':
          await runQuotaPeriodCleanup(supabase);
          break;
        case 'boost_expiry':
          await runBoostExpiry(supabase);
          break;
        case 'diary_reminder_sweep':
          await runDiaryReminderSweep(supabase, {
            // The flag is resolved HERE, not inside the job, for the same
            // reason webUrl is (see the next case): diaryReminder.job.ts stays
            // env-free and unit-testable, and its tests keep constructing deps
            // without touching Redis or Supabase.
            enabled: await getFlag('diary_reminder_enabled', false),
            push: async (to, text) => {
              await pushMessage(to, [{ type: 'text', text }], supabase, 'diary_sweep');
            },
          });
          break;
        case 'diary_addon_sweep':
          // หนูเก็บความทรงจำ (migration 052). WEB_URL is supplied here rather
          // than read inside the job so the job module stays env-free and
          // unit-testable.
          await runDiaryAddonSweep(supabase, {
            enabled: await getFlag('diary_addon_enabled', true),
            push: async (to, messages) => {
              await pushMessage(to, messages, supabase, 'diary_addon');
            },
            webUrl: config.WEB_URL,
          });
          break;
        case 'sheets_trial_expiry':
          // หนูเก็บลองงาน (migration 062). Config-dependent work is injected
          // here for the same reason as the two cases above — the job module
          // stays env-free and unit-testable.
          await runSheetsTrialExpiry(supabase, {
            // Context is explicit so the sweep's revoke failures are greppable
            // apart from a user-initiated disconnect's (FIX 1).
            revokeGrant: (userId, token) => revokeRefreshToken(userId, token, 'trial_sweep'),
            push: async (to, text) => {
              await pushMessage(to, [{ type: 'text', text }], supabase, 'sheets_trial');
            },
            // Best-effort tidy-up of a queued backfill. The stable jobId is the
            // one from enqueueHistoricalSync; `remove()` on an absent or
            // already-settled job is a no-op.
            cancelPendingSync: async (userId) => {
              const job = await getSheetsQueue().getJob(`sheets-historical-${userId}`);
              await job?.remove();
            },
            webUrl: config.WEB_URL,
          });

          // FIX 1 — the parked-disconnect retry rides the same 15-minute tick.
          // A separate function over a separate query (see the job's header);
          // it shares the cadence, not the logic. Run AFTER the trial sweep so
          // a user who is in both sets has their trial handled by the path that
          // knows about plans.
          await runGoogleRevokeRetry(supabase, {
            revokeGrant: (userId, token) => revokeRefreshToken(userId, token, 'pending_retry'),
          });
          break;
        default: {
          // Exhaustiveness guard: a new job type added to the union without a
          // case here fails to compile rather than being silently dropped.
          const never: never = job.data;
          throw new Error(`unknown membership job: ${JSON.stringify(never)}`);
        }
      }
    },
    {
      connection: createRedis() as unknown as ConnectionOptions,
      // Maintenance work is sequential by nature and touches whole tables —
      // concurrency 1 keeps two sweeps from fighting over the same rows.
      concurrency: 1,
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`[membership] job ${job?.name ?? 'unknown'} failed:`, err);
  });

  return worker;
}
