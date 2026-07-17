import { Worker, type Job } from 'bullmq';
import { createClient } from '@supabase/supabase-js';
import {
  TASK_QUEUE,
  type TaskJob,
  type TaskRecurNextJob,
  type TaskReminderJob,
} from '@nookeb/shared';
import { config } from '../config';
import { createRedis } from '../plugins/redis';
import { pushMessage, type LineMessage } from '../services/line.service';
import { buildMentionTextV2, buildReminderFlex } from '../services/lineMessage';
import {
  getReminder,
  getTaskWithDetails,
  resetRecurringRound,
  stampReminder,
  updateTask,
  type TaskWithDetails,
} from '../services/task.service';
import { computeNextOccurrence, scheduleReminders } from '../services/taskScheduler';

/**
 * ระบบตามงาน reminder worker — queue `nookeb-task-reminders`. Delivers scheduled
 * reminder pushes (the task feature's sanctioned push exception — see
 * line.service.ts) and rolls recurring tasks over to their next round.
 *
 * Retry discipline: jobs use BullMQ attempts (3, exponential 10s) because the
 * only side effect is the push itself. The handler re-checks the reminder row
 * and task state on every attempt, so a reminder cancelled/completed between
 * retries silently stands down. Final failure stamps task_reminders.failed_at
 * (worker 'failed' listener) — the queue never wedges on one bad job.
 */

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** Items covered by a reminder round: one item, or every global-deadline item. */
function roundItems(task: TaskWithDetails, itemId: string | null) {
  return task.items.filter((i) =>
    itemId ? i.id === itemId : !i.deadline,
  );
}

async function processTaskReminder(job: Job<TaskReminderJob>): Promise<void> {
  const { taskId, itemId, remindType, reminderId } = job.data;

  // Row-level idempotency: a retried/late job whose row was already resolved
  // (sent, cancelled by done/reschedule, failed) must never push again.
  const reminder = await getReminder(supabase, reminderId);
  if (!reminder || reminder.sent_at || reminder.cancelled_at || reminder.failed_at) return;

  const task = await getTaskWithDetails(supabase, taskId);
  if (!task || task.status === 'done' || task.status === 'cancelled') {
    await stampReminder(supabase, reminderId, 'cancelled_at');
    return;
  }

  const items = roundItems(task, itemId).filter(
    (i) => i.status !== 'done' && i.status !== 'cancelled',
  );
  const pending = items.flatMap((i) => i.assignees.filter((a) => a.done_at === null));
  if (pending.length === 0) {
    // Everyone in this round finished before the shot — stand down silently.
    await stampReminder(supabase, reminderId, 'cancelled_at');
    return;
  }

  const header =
    remindType === 'overdue'
      ? `งาน "${task.title}" เลยกำหนดแล้วน้า รีบหน่อยน้า`
      : `อย่าลืมงาน "${task.title}" น้า`;
  const item = itemId ? (roundItems(task, itemId)[0] ?? null) : null;

  // ONE push carrying both messages (mention first, then the Flex card).
  // LINE renders them as two bubbles in order; a single call keeps the pair
  // atomic, so a retry can never re-send the mention without the card.
  const messages = [
    buildMentionTextV2(pending, header) as unknown as LineMessage,
    buildReminderFlex(task, item, remindType),
  ];
  await pushMessage(task.group_line_id, messages);

  await stampReminder(supabase, reminderId, 'sent_at');
}

async function processRecurNext(job: Job<TaskRecurNextJob>): Promise<void> {
  const { taskId, occurrence } = job.data;
  const task = await getTaskWithDetails(supabase, taskId);
  if (!task || task.status === 'cancelled' || !task.recurrence_rule) return;
  // Stale rollover (deadline was rescheduled after this job was queued) — the
  // reschedule enqueued its own rollover for the new deadline.
  if (task.global_deadline !== new Date(occurrence).toISOString()) return;

  const next = computeNextOccurrence(task.recurrence_rule, new Date());
  await resetRecurringRound(supabase, taskId);
  await updateTask(supabase, taskId, {
    global_deadline: next.toISOString(),
    status: 'pending',
  });

  const rolled = await getTaskWithDetails(supabase, taskId);
  if (rolled) await scheduleReminders(supabase, rolled);
  console.log(`[task-worker] recurring task ${taskId} rolled over → ${next.toISOString()}`);
}

export function createTaskReminderWorker(): Worker<TaskJob> {
  const worker = new Worker<TaskJob>(
    TASK_QUEUE,
    async (job) => {
      switch (job.data.type) {
        case 'task_reminder':
          return processTaskReminder(job as Job<TaskReminderJob>);
        case 'task_recur_next':
          return processRecurNext(job as Job<TaskRecurNextJob>);
      }
    },
    { connection: createRedis(), concurrency: 5 },
  );

  worker.on('failed', (job, err) => {
    console.error(`[task-worker] job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message);
    // Out of retries → record the miss so the task page / ops can see it.
    if (
      job &&
      job.data.type === 'task_reminder' &&
      job.attemptsMade >= (job.opts.attempts ?? 1)
    ) {
      const { reminderId } = job.data;
      stampReminder(supabase, reminderId, 'failed_at').catch((stampErr) => {
        console.error(`[task-worker] could not stamp failed_at for ${reminderId}:`, stampErr);
      });
    }
  });

  return worker;
}
