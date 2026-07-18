import { Queue } from 'bullmq';
import dayjs from 'dayjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  REMIND_OFFSETS_MINUTES,
  TASK_NOTIFICATIONS_ENABLED,
  TASK_QUEUE,
  type RemindType,
  type TaskJob,
  type TaskRecord,
  type TaskReminderJob,
} from '@nookeb/shared';
import { createRedis } from '../plugins/redis';
import {
  effectiveDeadline,
  insertReminders,
  listOutstandingReminders,
  stampReminder,
  type ReminderInsert,
  type TaskWithDetails,
} from './task.service';
import { computeNextOccurrence } from './task-recurrence';

export { BANGKOK_TZ, computeNextOccurrence } from './task-recurrence';

/** Recurring rollover fires this long after the round's deadline — after the
 * overdue reminder (+60 min) so the round is chased before it resets. */
export const ROLLOVER_DELAY_MINUTES = 90;

const REMIND_TYPES: RemindType[] = ['3_days', '1_day', '3_hours', 'overdue'];

/**
 * Shared lazy queue: the API (schedule on create/patch/done) and the reminder
 * worker (self-scheduling recurring rollover) both go through this module, so
 * they can never drift on job ids. Job ids contain only UUID chars — the
 * BullMQ no-':' rule holds by construction.
 */
let queue: Queue<TaskJob> | null = null;
export function getTaskQueue(): Queue<TaskJob> {
  if (!queue) {
    queue = new Queue<TaskJob>(TASK_QUEUE, {
      connection: createRedis(),
      defaultJobOptions: {
        // Push delivery retry (decision: LINE rate-limit friendly): 3 attempts,
        // 10s → 20s → 40s. A job that still fails is recorded failed_at by the
        // worker's failed-handler and never blocks the queue (jobs are
        // independent; removeOnFail keeps Redis bounded).
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
  }
  return queue;
}

export async function closeTaskQueue(): Promise<void> {
  await queue?.close();
  queue = null;
}

export const reminderJobId = (reminderId: string): string => `reminder-${reminderId}`;
export const rolloverJobId = (taskId: string, deadlineIso: string): string =>
  `recur-${taskId}-${dayjs(deadlineIso).unix()}`;

/** Repeatable self-heal sweep for recurring tasks whose rollover chain broke
 * (see TaskRecurSweepJob). Registered once at worker startup — same pattern as
 * the file worker's purge_deleted. */
export async function scheduleTaskRepeatableJobs(): Promise<void> {
  await getTaskQueue().add(
    'task_recur_sweep',
    { type: 'task_recur_sweep' },
    { repeat: { every: 30 * 60 * 1000 }, jobId: 'task-recur-sweep' },
  );
}

/**
 * Distinct reminder targets for a task: items with their OWN deadline get
 * per-item reminders; all items inheriting global_deadline share ONE
 * task-level round (task_item_id NULL) so a multi task with a single global
 * deadline sends one card, not one per item.
 */
function reminderTargets(task: TaskWithDetails): { itemId: string | null; deadline: string }[] {
  const targets: { itemId: string | null; deadline: string }[] = [];
  let hasGlobalItems = false;
  for (const item of task.items) {
    if (item.deadline) targets.push({ itemId: item.id, deadline: item.deadline });
    else if (task.global_deadline) hasGlobalItems = true;
  }
  if (hasGlobalItems) targets.push({ itemId: null, deadline: task.global_deadline! });
  return targets;
}

/**
 * Create task_reminders rows + BullMQ delayed jobs for every future reminder
 * shot (3 วัน / 1 วัน / 3 ชม ก่อน + 1 ชม หลัง deadline). Rounds already in the
 * past are skipped entirely. For recurring tasks, also schedules the
 * self-rescheduling rollover job at deadline + 90 นาที.
 */
export async function scheduleReminders(
  supabase: SupabaseClient,
  task: TaskWithDetails,
): Promise<void> {
  const now = Date.now();
  const q = getTaskQueue();

  // SOFT-DISABLE (push not ready): skip creating the reminder rows/jobs (the
  // "อย่าลืมงาน" shots), but STILL schedule the recurring rollover below so
  // recurrence keeps advancing rounds. This is the one choke point for create /
  // reschedule / rollover, so flipping TASK_NOTIFICATIONS_ENABLED back on
  // re-enables reminders everywhere. Existing task_reminders rows are untouched.
  if (TASK_NOTIFICATIONS_ENABLED) {
    const rows: ReminderInsert[] = [];
    const delays = new Map<string, number>(); // key: `${itemId ?? 'task'}|${type}` → delay ms

    for (const target of reminderTargets(task)) {
      const deadlineMs = dayjs(target.deadline).valueOf();
      for (const type of REMIND_TYPES) {
        const remindAtMs = deadlineMs + REMIND_OFFSETS_MINUTES[type] * 60_000;
        if (remindAtMs <= now + 5_000) continue; // already past — skip
        rows.push({
          task_id: task.id,
          task_item_id: target.itemId,
          remind_type: type,
          remind_at: new Date(remindAtMs).toISOString(),
        });
        delays.set(`${target.itemId ?? 'task'}|${type}`, remindAtMs - now);
      }
    }

    const inserted = await insertReminders(supabase, rows);
    for (const row of inserted) {
      const delay = delays.get(`${row.task_item_id ?? 'task'}|${row.remind_type}`);
      if (delay === undefined) continue;
      const job: TaskReminderJob = {
        type: 'task_reminder',
        taskId: task.id,
        itemId: row.task_item_id,
        remindType: row.remind_type,
        reminderId: row.id,
      };
      await q.add('task_reminder', job, { jobId: reminderJobId(row.id), delay });
    }
  }

  if (task.type === 'recurring' && task.global_deadline) {
    const fireAt = dayjs(task.global_deadline).add(ROLLOVER_DELAY_MINUTES, 'minute').valueOf();
    await q.add(
      'task_recur_next',
      { type: 'task_recur_next', taskId: task.id, occurrence: task.global_deadline },
      { jobId: rolloverJobId(task.id, task.global_deadline), delay: Math.max(0, fireAt - now) },
    );
  }
}

/**
 * Withdraw every outstanding reminder: remove the delayed BullMQ jobs and stamp
 * cancelled_at (rows are kept — never deleted). Removal is best-effort per job:
 * a job already picked up by the worker can't be removed, but its handler
 * re-checks the row's cancelled_at before sending, so a lost race stays silent.
 */
export async function cancelReminders(
  supabase: SupabaseClient,
  task: Pick<TaskRecord, 'id' | 'type' | 'global_deadline'>,
): Promise<void> {
  const q = getTaskQueue();
  const outstanding = await listOutstandingReminders(supabase, task.id);
  for (const row of outstanding) {
    try {
      const job = await q.getJob(reminderJobId(row.id));
      await job?.remove();
    } catch (err) {
      console.warn(`[taskScheduler] could not remove job for reminder ${row.id}:`, err);
    }
    await stampReminder(supabase, row.id, 'cancelled_at');
  }
  if (task.type === 'recurring' && task.global_deadline) {
    try {
      const job = await q.getJob(rolloverJobId(task.id, task.global_deadline));
      await job?.remove();
    } catch (err) {
      console.warn(`[taskScheduler] could not remove rollover job for task ${task.id}:`, err);
    }
  }
}

/** cancel + schedule with the task's CURRENT (already-updated) deadlines.
 * `previousDeadline` is the pre-update global_deadline, needed to find the old
 * recurring rollover job. */
export async function rescheduleReminders(
  supabase: SupabaseClient,
  task: TaskWithDetails,
  previousDeadline?: string | null,
): Promise<void> {
  await cancelReminders(supabase, {
    id: task.id,
    type: task.type,
    global_deadline: previousDeadline ?? task.global_deadline,
  });
  await scheduleReminders(supabase, task);
}

