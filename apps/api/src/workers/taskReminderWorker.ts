import { Worker, type Job } from 'bullmq';
import { createClient } from '@supabase/supabase-js';
import {
  TASK_NOTIFICATIONS_ENABLED,
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
  listOutstandingReminders,
  notifyTarget,
  resetRecurringRound,
  stampReminder,
  updateTask,
  type TaskWithDetails,
} from '../services/task.service';
import {
  computeNextOccurrence,
  getTaskQueue,
  ROLLOVER_DELAY_MINUTES,
  rolloverJobId,
  scheduleReminders,
} from '../services/taskScheduler';

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

  // SOFT-DISABLE (push not ready): stand down silently without pushing. Belt-
  // and-braces for reminder jobs that were queued BEFORE the flag flipped —
  // scheduleReminders no longer creates new ones. The row is left unstamped
  // (not marked sent/failed) so no false delivery is recorded. Flip
  // TASK_NOTIFICATIONS_ENABLED back on and freshly-created tasks schedule and
  // deliver reminders normally again.
  if (!TASK_NOTIFICATIONS_ENABLED) return;

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

  // Group → the group chat; personal → the owner's own chat (migration 043).
  // A null target can only mean a row that violates the 043 CHECK: stand down
  // silently instead of throwing, so one malformed task can't wedge the queue.
  const target = notifyTarget(task);
  if (!target) {
    console.warn(`[task-worker] task ${task.id} has no notify target — standing down`);
    await stampReminder(supabase, reminderId, 'cancelled_at');
    return;
  }

  // ONE push carrying both messages (mention first, then the Flex card).
  // LINE renders them as two bubbles in order; a single call keeps the pair
  // atomic, so a retry can never re-send the mention without the card.
  //
  // Personal tasks send the card ALONE: the sole recipient is the owner, and
  // @mentioning someone in their own 1-on-1 chat is meaningless (LINE may also
  // reject the mentionee outright there).
  const messages: LineMessage[] = task.is_personal
    ? [buildReminderFlex(task, item, remindType)]
    : [
        buildMentionTextV2(pending, header) as unknown as LineMessage,
        buildReminderFlex(task, item, remindType),
      ];
  await pushMessage(target, messages);

  await stampReminder(supabase, reminderId, 'sent_at');
}

/** Close the current round and open the next: reset marks, move the deadline
 * to the next occurrence, schedule the new round's reminders + rollover. */
async function rollTaskOver(task: TaskWithDetails): Promise<void> {
  const next = computeNextOccurrence(task.recurrence_rule!, new Date());
  await resetRecurringRound(supabase, task.id);
  await updateTask(supabase, task.id, {
    global_deadline: next.toISOString(),
    status: 'pending',
  });

  const rolled = await getTaskWithDetails(supabase, task.id);
  if (rolled) await scheduleReminders(supabase, rolled);
  console.log(`[task-worker] recurring task ${task.id} rolled over → ${next.toISOString()}`);
}

/**
 * A stale rollover found the deadline already moved. Usually a reschedule/an
 * earlier attempt owns the new deadline and has scheduled its round — but an
 * attempt that crashed BETWEEN the deadline move and scheduleReminders left
 * the round with nothing scheduled (and the plain stale-return would freeze
 * the task forever, because nothing else ever re-triggers the chain). Repair:
 * if the current deadline has neither outstanding reminder rows nor a live
 * rollover job, schedule them now.
 */
async function repairRoundIfUnscheduled(task: TaskWithDetails): Promise<void> {
  if (!task.global_deadline) return;
  const outstanding = await listOutstandingReminders(supabase, task.id);
  if (outstanding.length > 0) return;
  const rollover = await getTaskQueue().getJob(rolloverJobId(task.id, task.global_deadline));
  if (rollover) return;
  console.warn(`[task-worker] recurring task ${task.id} had an unscheduled round — repairing`);
  await scheduleReminders(supabase, task);
}

async function processRecurNext(job: Job<TaskRecurNextJob>): Promise<void> {
  const { taskId, occurrence } = job.data;
  const task = await getTaskWithDetails(supabase, taskId);
  if (!task || task.status === 'cancelled' || !task.recurrence_rule) return;
  // Stale rollover (deadline moved after this job was queued): the mover owns
  // the new round — but verify it actually got scheduled (crash repair above).
  if (task.global_deadline !== new Date(occurrence).toISOString()) {
    await repairRoundIfUnscheduled(task);
    return;
  }

  await rollTaskOver(task);
}

/**
 * Periodic self-heal (repeatable, every 30 min): the rollover chain is
 * self-scheduling, so a task_recur_next job that died (all push/DB attempts
 * failed, or Redis lost the delayed job) freezes its task with a past deadline
 * and no future rounds. Re-roll any recurring task whose deadline+delay has
 * passed and whose rollover job is gone or dead. A rollover job that still
 * exists in a runnable state is left alone — BullMQ will deliver it (e.g. the
 * worker was down and just caught up).
 */
async function processRecurSweep(): Promise<void> {
  const cutoffIso = new Date(Date.now() - ROLLOVER_DELAY_MINUTES * 60_000).toISOString();
  const { data, error } = await supabase
    .from('tasks')
    .select('id')
    .eq('type', 'recurring')
    .neq('status', 'cancelled')
    .is('deleted_at', null)
    .lt('global_deadline', cutoffIso);
  if (error) throw error;

  for (const row of (data ?? []) as { id: string }[]) {
    try {
      const task = await getTaskWithDetails(supabase, row.id);
      if (
        !task ||
        task.status === 'cancelled' ||
        !task.recurrence_rule ||
        !task.global_deadline ||
        new Date(task.global_deadline).toISOString() >= cutoffIso
      ) {
        continue;
      }
      const job = await getTaskQueue().getJob(rolloverJobId(task.id, task.global_deadline));
      const state = job ? await job.getState() : null;
      if (job && state !== 'failed' && state !== 'unknown') continue; // still runnable
      if (job) await job.remove().catch(() => {});
      console.warn(
        `[task-worker] sweep: recurring task ${task.id} stuck at ${task.global_deadline} (rollover job ${state ?? 'missing'}) — re-rolling`,
      );
      await rollTaskOver(task);
    } catch (err) {
      console.error(`[task-worker] sweep failed for task ${row.id}:`, err);
    }
  }
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
        case 'task_recur_sweep':
          return processRecurSweep();
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
