import { Worker, type Job } from 'bullmq';
import { createClient } from '@supabase/supabase-js';
import {
  TASK_NOTIFICATIONS_ENABLED,
  TASK_QUEUE,
  type TaskJob,
  type TaskNotifyJob,
  type TaskRecurNextJob,
  type TaskReminderJob,
} from '@nookeb/shared';
import { config } from '../config';
import { createRedis } from '../plugins/redis';
import { LinePushError, pushMessage, type LineMessage } from '../services/line.service';
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
import { consumeQuota, releaseQuota } from '../services/quota.service';
import { normalizePlan } from '../config/plans';
import { planAllows } from '../middleware/planGuard';

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

/**
 * Resolve a LINE uid to its nookeb user row, which is where `plan` lives.
 * Returns null when the creator never logged into the web app — they have no
 * users row, hence no plan and no quota to charge.
 */
async function userByLineUid(
  lineUid: string,
): Promise<{ id: string; plan: string | null } | null> {
  const { data } = await supabase
    .from('users')
    .select('id, plan')
    .eq('line_user_id', lineUid)
    .maybeSingle();
  return (data as { id: string; plan: string | null } | null) ?? null;
}

/** §4c entitlement, re-checked at delivery time. */
async function creatorMayTargetPending(creatorLineUid: string): Promise<boolean> {
  const row = await userByLineUid(creatorLineUid);
  return planAllows(row?.plan, 'notify_only_pending');
}

/**
 * §4a — reserve one notification unit from the task creator's monthly
 * allowance. Returns true when the push may go out.
 *
 * A creator with no users row (chat-only user who never signed in) is ALLOWED:
 * they have no plan to meter against, and silently dropping their reminders
 * would break a flow that works today for reasons unrelated to membership.
 */
async function consumeNotificationQuota(creatorLineUid: string): Promise<boolean> {
  const row = await userByLineUid(creatorLineUid);
  if (!row) return true;
  try {
    const decision = await consumeQuota(supabase, {
      userId: row.id,
      feature: 'task_notifications',
      plan: normalizePlan(row.plan),
    });
    return decision.allowed;
  } catch (err) {
    // Fail OPEN. A quota lookup that errors must not silently stop reminders —
    // the failure mode of a missed deadline is worse than one uncounted push.
    console.error(`[task-worker] notification quota check failed for ${row.id}:`, err);
    return true;
  }
}

/**
 * §4a — hand back a unit reserved for a push that did NOT go out (LINE rejected
 * it, timed out, or is rate-limiting us). Mirrors consumeNotificationQuota:
 * a creator with no users row was never charged, so there is nothing to release.
 *
 * Never throws. The caller is already on a failure path — a release that fails
 * must not mask the original push error, and the worst case is one uncounted
 * unit, which is the same failure mode consumeNotificationQuota already accepts.
 */
async function releaseNotificationQuota(creatorLineUid: string): Promise<void> {
  const row = await userByLineUid(creatorLineUid).catch(() => null);
  if (!row) return;
  try {
    await releaseQuota(supabase, { userId: row.id, feature: 'task_notifications' });
  } catch (err) {
    console.error(`[task-worker] notification quota release failed for ${row.id}:`, err);
  }
}

/**
 * FIX 13 — is this LINE push failure permanent, i.e. will retrying it produce
 * the exact same rejection?
 *
 * True for a 4xx that is NOT 429: the user blocked the OA (403), the uid is
 * stale or was never valid (400), the token lost its scope (401). BullMQ's
 * three attempts against any of those are three identical rejections spread
 * over ~30 seconds of backoff, holding a worker slot behind this queue's
 * 10/sec limiter for nothing.
 *
 * False — so the caller rethrows and BullMQ retries — for:
 *   429  LINE's rate limit, the one 4xx that genuinely clears on its own;
 *   5xx  LINE is having a bad minute;
 *   0    LinePushError's timeout sentinel (see line.service.pushMessage), plus
 *        any non-LinePushError (a DNS blip, a thrown network error), which
 *        reach here as 0 and must stay retryable.
 */
function isPermanentPushError(err: unknown): boolean {
  const status = err instanceof LinePushError ? err.status : 0;
  return status >= 400 && status < 500 && status !== 429;
}

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

  // §4c — "เตือนเฉพาะคนที่ยังไม่ส่งงาน". When the creator enabled it (pro/premium
  // only, gated at create time), items already SUBMITTED are excluded from the
  // round even though they are not yet approved: the assignee has done their
  // part and chasing them is exactly what the option is for.
  //
  // The flag is honoured only if the creator STILL has the entitlement — the
  // same delivery-time re-check the Sheets mirror does, so a downgrade takes
  // effect on the next shot rather than at the next task creation.
  const onlyPending =
    task.notify_only_pending === true && (await creatorMayTargetPending(task.created_by_line_uid));

  const items = roundItems(task, itemId).filter(
    (i) =>
      i.status !== 'done' &&
      i.status !== 'cancelled' &&
      !(onlyPending && i.status === 'submitted'),
  );
  const pending = items.flatMap((i) => i.assignees.filter((a) => a.done_at === null));
  if (pending.length === 0) {
    // Everyone in this round finished (or, with §4c on, has submitted) before
    // the shot — stand down silently.
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

  // §4a — the monthly notification allowance (free 7 / pro 30 / premium 100) is
  // charged to the task's CREATOR, and charged PER PUSH rather than per task:
  // a task with four reminder shots costs four units. Reserved immediately
  // BEFORE the push (nothing between this line and pushMessage may return), so
  // an exhausted allowance never sends — and RELEASED again below if the push
  // does not actually go out.
  //
  // A blocked reminder is stamped cancelled_at, not failed_at: nothing broke,
  // the user simply has no allowance left, and failed_at would page ops.
  const notifySpend = await consumeNotificationQuota(task.created_by_line_uid);
  if (!notifySpend) {
    console.log(
      `[task-worker] reminder ${reminderId} skipped — notification quota exhausted for ${task.created_by_line_uid}`,
    );
    await stampReminder(supabase, reminderId, 'cancelled_at');
    return;
  }

  try {
    await pushMessage(target, messages);
  } catch (err) {
    // The message did NOT go out, so the unit reserved above must go back
    // BEFORE we decide whether to retry. Without this, every failed attempt
    // burned a unit permanently: the row is left unstamped on a transient
    // failure (that is what lets BullMQ retry it), so the guard at the top of
    // this handler does not stop the next attempt from charging again — a free
    // creator lost all three of a shot's attempts out of seven monthly units,
    // silently.
    await releaseNotificationQuota(task.created_by_line_uid);

    if (isPermanentPushError(err)) {
      // Permanent LINE error (user blocked the OA, invalid/stale uid, malformed
      // payload). Retrying cannot help, so settle the job here: stamp the miss
      // and return WITHOUT rethrowing, instead of burning two more attempts to
      // reach the same failed_at via the worker's 'failed' listener. A timeout
      // reports status 0 and a 429/5xx is transient — both fall through below.
      const status = err instanceof LinePushError ? err.status : 0;
      await stampReminder(supabase, reminderId, 'failed_at').catch((stampErr) => {
        console.error(`[task-worker] could not stamp failed_at for ${reminderId}:`, stampErr);
      });
      console.warn(
        `[task-worker] reminder ${reminderId} permanent LINE error (status=${status}) — no quota charged, not retrying`,
      );
      return;
    }
    // Transient (429 rate limit, 5xx, network/timeout) — let BullMQ retry with
    // its backoff. No quota is charged for this attempt.
    throw err;
  }

  // Delivered. From here on nothing may throw: the push cannot be un-sent, so a
  // DB hiccup while stamping must not retry the job and push a second time.
  await stampReminder(supabase, reminderId, 'sent_at').catch((err) => {
    console.error(
      `[task-worker] reminder ${reminderId} was DELIVERED but sent_at could not be stamped:`,
      err,
    );
  });
}

/**
 * Deliver one immediate task notice (announcement / cancel / review loop).
 *
 * Deliberately thinner than processTaskReminder: there is no row to stamp and
 * no per-recipient state, so BullMQ's own attempts/backoff is the whole retry
 * story. It does NOT charge the §4a notification quota — that allowance meters
 * SCHEDULED reminders, which the creator opted into by count; an announcement
 * or a "งานผ่านแล้ว" notice is part of the task action itself, and metering it
 * would silently disable the review loop for a free user who used their seven
 * units on reminders.
 */
async function processTaskNotify(job: Job<TaskNotifyJob>): Promise<void> {
  const { to, messages, taskId, context } = job.data;

  // Belt-and-braces for jobs queued before the switch flipped (the enqueue side
  // is gated too, so in practice this only catches an in-flight backlog).
  if (!TASK_NOTIFICATIONS_ENABLED) return;
  if (!to || messages.length === 0) return;

  // FIX 13 — same permanent/transient split as processTaskReminder. This path
  // used to let EVERY failure propagate, so a creator who blocked the OA (or a
  // group the bot was removed from) turned each announcement / cancel notice /
  // review-loop notice into three identical 4xx rejections behind this queue's
  // 10/sec limiter.
  //
  // There is no reminder row to stamp here and no §4a quota to release — this
  // handler charges neither — so a permanent failure is simply logged and the
  // job settles as complete. "Complete" is the honest outcome: the notice will
  // never be deliverable to this target, and failing the job would only leave a
  // permanently-red entry that ops cannot action.
  try {
    await pushMessage(to, messages as LineMessage[]);
  } catch (err) {
    if (isPermanentPushError(err)) {
      const status = err instanceof LinePushError ? err.status : 0;
      console.warn(
        `[task-worker] ${context} notice for task ${taskId} hit a permanent LINE error (status=${status}) — not retrying`,
      );
      return;
    }
    throw err; // transient (429 / 5xx / timeout) — let BullMQ retry
  }
  console.log(`[task-worker] ${context} notice delivered for task ${taskId}`);
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
  if (error) {
    // Never throw from the repeatable sweep: a transient DB blip must not burn
    // BullMQ attempts and leave failed iteration hashes behind (part of why the
    // sweep's repeat keys used to pile up). The next 30-min tick retries the
    // whole scan, so nothing is lost by standing down this round.
    console.error('[task-worker] sweep: task query failed — skipping this round:', error);
    return;
  }

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
        case 'task_notify':
          return processTaskNotify(job as Job<TaskNotifyJob>);
      }
    },
    // drainDelay is in SECONDS (default 5): a high value makes an EMPTY queue
    // block for a long time before timing out, so idle polling is near-zero.
    // Bypassed whenever a delayed job is pending: this queue's `task-recur-sweep`
    // scheduler keeps one perpetually pending, so BullMQ caps the block at its
    // hard 10s `maximumBlockTimeout` and drainDelay has no effect here (see the
    // root-cause note in taskScheduler.scheduleTaskRepeatableJobs). Kept high for
    // the empty-delayed-set case. stalledInterval/lockDuration: see upload.worker.
    {
      connection: createRedis(),
      concurrency: 5,
      drainDelay: 20000,
      stalledInterval: 60_000,
      lockDuration: 60_000,
      // ---- LINE push throttle ----
      //
      // EVERY task push in the product now lands on this queue (reminders +
      // announcements + cancel + review loop), so this one limiter is the whole
      // product's push governor. BullMQ enforces it ACROSS the worker, not per
      // job, so `concurrency: 5` can never exceed it.
      //
      // 10/sec is far below anything LINE rejects — the Messaging API's
      // documented technical ceiling is 2,000 requests/second for /message/push
      // (replies are separate and unmetered). The number is chosen against the
      // OTHER limit, the one that actually bites: the monthly push-message
      // ALLOWANCE, which is quota-metered and fails silently once spent. A
      // reminder round that fans out over minutes instead of milliseconds costs
      // nothing in user experience (these messages are deadline-driven, not
      // conversational) and keeps a bad day from draining the month.
      //
      // It is also the blast shield for the first boot with
      // TASK_NOTIFICATIONS_ENABLED on: a backlog of due reminder jobs drains at
      // a bounded rate instead of stampeding LINE. (Reminder ROWS are only
      // written by scheduleReminders while the switch is on, so there is no
      // hidden backlog from the disabled period — but a large group's first real
      // day is burst-shaped all the same.)
      limiter: { max: 10, duration: 1000 },
    },
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
