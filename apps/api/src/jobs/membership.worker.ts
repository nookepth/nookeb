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
import { MEMBERSHIP_QUEUE, type MembershipJob } from './membership.queue';
import { runQuotaPeriodCleanup } from './quotaReset.job';
import { runBoostExpiry } from './boostExpiry.job';
import { runDiaryAddonSweep, runDiaryReminderSweep } from './diaryReminder.job';

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
