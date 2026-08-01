import { Queue } from 'bullmq';
import dayjs from 'dayjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  REMIND_OFFSETS_MINUTES,
  REMIND_TYPE_BY_INTERVAL_HOURS,
  TASK_NOTIFICATIONS_ENABLED,
  TASK_QUEUE,
  type RemindType,
  type TaskJob,
  type TaskNotifyJob,
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
import { selectRemindTypes } from './task-command';

export { BANGKOK_TZ, computeNextOccurrence } from './task-recurrence';

/** Recurring rollover fires this long after the round's deadline — after the
 * overdue reminder (+60 min) so the round is chased before it resets. */
export const ROLLOVER_DELAY_MINUTES = 90;

/** How often the recurring-task self-heal sweep runs (see scheduleTaskRepeatableJobs). */
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

/** Ordered furthest-out → latest, so scheduled shots read chronologically. */
const REMIND_TYPES: RemindType[] = [
  '3_days',
  '2_days',
  '1_day',
  '6_hours',
  '3_hours',
  'overdue',
];

/**
 * Which shots a task fires, in schedule order.
 *
 * Precedence:
 *  1. §4b `reminder_intervals` — the creator's checkbox selection, already
 *     validated against their plan at create time. Every plan picks from the
 *     SAME five intervals; the plan only caps how many.
 *  2. Legacy `reminder_count` — the Pro "เตือน N ครั้ง" chat command
 *     (migration 047). Kept working; nothing else sets it.
 *  3. Neither → NO shots.
 *
 * There is deliberately no fallback schedule. A reminder fires only at a time
 * the creator asked for: inventing one (whether the old four-shot default or a
 * single at-deadline ping) would mean a FREE user receiving reminders they
 * never selected, on a plan whose entitlement is exactly one selection.
 */
export function resolveShots(task: Pick<TaskRecord, 'reminder_count'> & {
  reminder_intervals?: number[] | null;
}): RemindType[] {
  const intervals = task.reminder_intervals;
  if (intervals && intervals.length > 0) {
    const chosen = new Set(
      intervals
        .map((h) => REMIND_TYPE_BY_INTERVAL_HOURS[h])
        .filter((t): t is RemindType => t !== undefined),
    );
    if (chosen.size > 0) return REMIND_TYPES.filter((t) => chosen.has(t));
  }
  if (typeof task.reminder_count === 'number') {
    const chosen = new Set(selectRemindTypes(task.reminder_count));
    return REMIND_TYPES.filter((t) => chosen.has(t));
  }
  return [];
}

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
        // Bounded retention for reminder + rollover jobs. The 30-min
        // task-recur-sweep now runs via upsertJobScheduler (see
        // scheduleTaskRepeatableJobs) with its OWN tighter removeOnComplete, so
        // its fired iterations self-trim rather than piling up as TTL-less
        // `repeat:<hash>:<ms>` hashes the way the legacy repeat strategy left them.
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return queue;
}

export async function closeTaskQueue(): Promise<void> {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  await queue?.close();
  queue = null;
}

/**
 * Queue ONE immediate task push (announcement / cancel notice / review-loop
 * notice). See TaskNotifyJob for why these are queued rather than pushed inline.
 *
 * Fire-and-forget by design: the caller is an HTTP handler whose write has
 * already committed, so a Redis hiccup must degrade to "the notice was not
 * sent", never to a 500 on a request that succeeded. The await-less contract is
 * the same one enqueueSheetsSync already uses.
 *
 * NO custom jobId. These are one-shot notices, and a stable id would make BullMQ
 * silently swallow the second legitimate notice of the same kind for the same
 * task (the sheets_sync lesson) — e.g. a submit → ตีกลับ → submit round trip.
 *
 * Gated on TASK_NOTIFICATIONS_ENABLED here as well as in the worker: while the
 * switch is off nothing is even queued, so flipping it on does not release a
 * backlog of stale notices.
 */
export function enqueueTaskNotify(params: {
  to: string;
  messages: unknown[];
  taskId: string;
  context: string;
}): void {
  if (!TASK_NOTIFICATIONS_ENABLED) return;
  const job: TaskNotifyJob = { type: 'task_notify', ...params };
  void getTaskQueue()
    .add('task_notify', job)
    .catch((err) => {
      console.error(
        `[taskScheduler] could not queue ${params.context} notice for task ${params.taskId}:`,
        err,
      );
    });
}

export const reminderJobId = (reminderId: string): string => `reminder-${reminderId}`;
export const rolloverJobId = (taskId: string, deadlineIso: string): string =>
  `recur-${taskId}-${dayjs(deadlineIso).unix()}`;

/** In-process timer handle for the recurring-sweep (cleared on shutdown). */
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Enqueue one task_recur_sweep job with ZERO delay. jobId is bucketed by the
 * 30-min window: idempotent within a window (crash-loop / boot-time fire) and
 * unique across windows. A zero-delay job never enters the `delayed` ZSET, so it
 * does not pin the worker's blocking poll to BullMQ's 10s maximumBlockTimeout
 * (see the createTaskReminderWorker drainDelay note). The sweep is a read-only
 * self-heal, so an occasional double-run is harmless. */
async function enqueueSweep(): Promise<void> {
  const q = getTaskQueue();
  const bucket = Math.floor(Date.now() / SWEEP_INTERVAL_MS);
  try {
    await q.add(
      'task_recur_sweep',
      { type: 'task_recur_sweep' },
      {
        jobId: `task-recur-sweep-${bucket}`,
        removeOnComplete: { count: 20 },
        removeOnFail: { count: 50 },
      },
    );
  } catch (err) {
    // Duplicate-jobId rejection is the expected idempotency no-op.
    console.warn('[taskScheduler] sweep enqueue skipped/failed:', err);
  }
}

/** Self-heal sweep for recurring tasks whose rollover chain broke (see
 * TaskRecurSweepJob). Registered once at worker startup as an IN-PROCESS interval
 * that enqueues a zero-delay job — NOT a BullMQ repeatable / job scheduler.
 *
 * Why not upsertJobScheduler: a scheduler keeps one future job perpetually in the
 * `delayed` ZSET, and BullMQ caps an idle worker's blocking BZPOPMIN at 10s while
 * ANY delayed job is pending (maximumBlockTimeout, worker.js) — so this queue's
 * worker re-ran moveToActive every ~10s forever even with zero tasks. Enqueuing a
 * zero-delay job on a timer keeps the delayed set empty between runs, so idle
 * polling drops to near-zero, while still avoiding the legacy `repeat:<hash>:<ms>`
 * orphan-key leak the scheduler migration originally fixed (no repeat hashes at
 * all). Trade-off: the timer resets on process restart, fine for a 30-min
 * self-heal; single Railway replica today, and the bucketed jobId collapses
 * concurrent enqueues if it is ever scaled out. Real reminder/rollover DELAYED
 * jobs still exist when tasks are active — that polling is proportional to actual
 * scheduled work, not a constant idle drain. */
export async function scheduleTaskRepeatableJobs(): Promise<void> {
  const q = getTaskQueue();
  // One-time cleanup: drop BOTH the legacy repeatable AND the upsertJobScheduler
  // entry a prior deploy created — either leaves a standing delayed job that
  // keeps pinning the blocking poll to 10s. Both no-op once gone. Historical
  // `repeat:<hash>:<ms>` orphan hashes are cleared separately by `npm run cleanup:redis`.
  try {
    await q.removeRepeatable('task_recur_sweep', { every: SWEEP_INTERVAL_MS }, 'task-recur-sweep');
  } catch (err) {
    console.warn('[taskScheduler] could not remove legacy sweep repeatable:', err);
  }
  try {
    await q.removeJobScheduler('task-recur-sweep');
  } catch (err) {
    console.warn('[taskScheduler] could not remove sweep job scheduler:', err);
  }
  await enqueueSweep();
  sweepTimer = setInterval(() => void enqueueSweep(), SWEEP_INTERVAL_MS);
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

    // Which shots to fire — see resolveShots for the precedence rules.
    const shots = resolveShots(task);

    for (const target of reminderTargets(task)) {
      const deadlineMs = dayjs(target.deadline).valueOf();
      for (const type of shots) {
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

