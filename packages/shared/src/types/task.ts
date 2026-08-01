/**
 * ระบบตามงาน (Task Manager) — migration 036.
 *
 * Tasks are created from the LIFF web flow (never by typing LINE commands),
 * announced into the LINE group as a Flex push, and chased by scheduled
 * reminder pushes (3 days / 1 day / 3 hours before + 1 hour past deadline).
 *
 * NOTE ON PUSH: this feature is the codebase's ONE deliberate exception to the
 * reply-only messaging rule — a LIFF submit and a scheduled reminder have no
 * replyToken to spend, so both go out as pushes (see pushMessage in
 * line.service.ts). Interactive completions (postback "เสร็จแล้ว") still use
 * the free reply path.
 */

/** BullMQ queue for task reminders (separate from nookeb-file-processing so a
 * file-processing backlog can never delay a time-sensitive reminder). */
export const TASK_QUEUE = 'nookeb-task-reminders';

export type TaskType = 'single' | 'multi' | 'recurring';
export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';
/**
 * Per-item status (migration 045). A task ITEM can additionally sit in the
 * review loop — 'submitted' (ผู้รับผิดชอบส่งงานกลับ, รอคนสั่งตรวจ) and
 * 'rejected' (คนสั่งตีกลับพร้อมเหตุผล). `tasks.status` deliberately does NOT
 * gain these: reviewing is a conversation about one item, and widening the
 * task-level vocabulary would break every roll-up/filter that assumes four
 * states.
 */
export type TaskItemStatus = TaskStatus | 'submitted' | 'rejected';
/**
 * Reminder shot identifiers.
 *
 * The first four are the ORIGINAL default schedule (migration 036). `2_days`
 * and `6_hours` were added by the membership system (migration 051) so the §4b
 * checkbox set — 3h / 6h / 1d / 2d / 3d — is fully expressible.
 *
 * There is NO zero-offset shot: a reminder fires only at an interval the
 * creator selected, and selecting nothing schedules nothing. (`overdue` is the
 * pre-existing +1h chase, reachable only via the legacy `reminder_count` chat
 * command — it is not one of the five selectable intervals.)
 *
 * Adding a value here REQUIRES widening the task_reminders.remind_type CHECK —
 * migration 051 does that. Keep this union and that constraint in lockstep.
 */
export type RemindType =
  | '3_days'
  | '1_day'
  | '3_hours'
  | 'overdue'
  | '2_days'
  | '6_hours';

/**
 * ความเร่งด่วน picked at creation (migration 048), most→least urgent. Stored
 * as these canonical keys — the Thai labels (🔴 ด่วนมาก …) are presentation,
 * owned by the web UI and the Google Sheets workspace mapping.
 */
export type TaskUrgency = 'urgent_max' | 'urgent' | 'normal' | 'relaxed';
export const TASK_URGENCIES: readonly TaskUrgency[] = [
  'urgent_max', 'urgent', 'normal', 'relaxed',
] as const;

/** Ordered mapping of reminder type → offset from the deadline (minutes;
 * negative = before). Shared so the scheduler and .ics VALARMs agree. */
export const REMIND_OFFSETS_MINUTES: Record<RemindType, number> = {
  '3_days': -3 * 24 * 60,
  '2_days': -2 * 24 * 60,
  '1_day': -24 * 60,
  '6_hours': -6 * 60,
  '3_hours': -3 * 60,
  overdue: 60,
};

/**
 * §4b — the user-selectable reminder lead times, in HOURS before the deadline,
 * mapped to the shot they schedule. The hour values are what
 * `tasks.reminder_intervals` stores; the RemindType is what
 * `task_reminders.remind_type` stores.
 *
 * Kept here rather than in the API so the .ics VALARM builder, the scheduler
 * and any future client all read one table.
 */
export const REMIND_TYPE_BY_INTERVAL_HOURS: Record<number, RemindType> = {
  3: '3_hours',
  6: '6_hours',
  24: '1_day',
  48: '2_days',
  72: '3_days',
};

export interface RecurrenceRule {
  freq: 'daily' | 'weekly' | 'monthly';
  /** monthly: day of month 1–31 (clamped to the month's last day) */
  day?: number;
  /** weekly: 0 (Sunday) – 6 (Saturday) */
  weekday?: number;
  /** "HH:mm" in Asia/Bangkok */
  time: string;
}

export interface TaskRecord {
  id: string;
  space_id: string | null;
  /**
   * NULL for personal tasks (migration 043). A personal task's tenant key is
   * owner_line_uid, which comes from the verified LINE Login session — a LINE
   * user id must NEVER be stored here (the group-id capability model only holds
   * for unguessable group ids; see the 043 header).
   */
  group_line_id: string | null;
  is_personal: boolean;
  /** Set iff is_personal — the owner's line_uid. NULL for group tasks. */
  owner_line_uid: string | null;
  title: string;
  type: TaskType;
  global_deadline: string | null;
  recurrence_rule: RecurrenceRule | null;
  status: TaskStatus;
  created_by_line_uid: string;
  created_at: string;
  deleted_at: string | null;
  /**
   * How many reminder shots to schedule (migration 047), 1..4. NULL = the full
   * default schedule (3 วัน / 1 วัน / 3 ชม ก่อน + 1 ชม หลัง). A custom count is a
   * Pro feature set via the "หนูเก็บสั่งงาน … เตือน N ครั้ง" command; free tasks
   * stay NULL. Optional so rows read before migration 047 don't fail the type —
   * treat missing as NULL/default. See selectRemindTypes in task-command.ts.
   */
  reminder_count?: number | null;
  /**
   * §4b — the creator's reminder checkbox selection (migration 051), in HOURS
   * before the effective deadline, e.g. [24, 6]. Values come from
   * REMIND_INTERVAL choices only, and how many may be ticked is a plan limit
   * (free 1 / pro 2 / premium 4) enforced server-side at create time.
   *
   * NULL/absent = the creator selected nothing, which schedules NO reminder
   * shots. There is no deadline-only fallback. Optional so rows read before
   * migration 051 don't fail the type.
   */
  reminder_intervals?: number[] | null;
  /**
   * §4c — when true, a reminder skips assignees who have already submitted.
   * Pro/premium only, gated at write time. Optional for pre-051 rows; treat
   * missing as false.
   */
  notify_only_pending?: boolean;
  /**
   * ความเร่งด่วน picked at creation (migration 048). NULL = ปกติ. Optional so
   * rows read before the migration don't fail the type; inserts only include
   * the column when a value was chosen (additive-safe, like reminder_count).
   */
  urgency?: TaskUrgency | null;
}

export interface TaskItemRecord {
  id: string;
  task_id: string;
  title: string;
  description: string | null;
  deadline: string | null;
  status: TaskItemStatus;
  sort_order: number;
  deleted_at: string | null;
  /** migration 045 — review loop. Stamped when the item is submitted for review. */
  submitted_at: string | null;
  /** migration 045 — stamped when the creator sends it back. */
  rejected_at: string | null;
  /** migration 045 — why it was sent back; cleared on the next submit. */
  rejection_note: string | null;
  /** migration 045 — note that came with the latest submission. */
  submission_note: string | null;
}

export interface TaskAssigneeRecord {
  id: string;
  task_item_id: string;
  line_uid: string;
  display_name: string | null;
  picture_url: string | null;
  accepted_at: string | null;
  done_at: string | null;
  /** short note the assignee left when marking done (migration 037); editable */
  done_note: string | null;
}

/** Reference link attached to a task (task-level, migration 037). */
export interface TaskLinkRecord {
  id: string;
  task_id: string;
  url: string;
  label: string | null;
  sort_order: number;
  created_by_line_uid: string;
  created_at: string;
}

/**
 * File attached to a task (migration 045). The bytes live in a normal `files`
 * row — space, quota ledger and soft-delete all behave exactly as for a LINE
 * upload; this row only binds that file to a task.
 */
export interface TaskFileRecord {
  id: string;
  task_id: string;
  /** NULL = task-level (แนบตอนสร้างงาน); set = attached to one item's submission */
  task_item_id: string | null;
  file_id: string;
  uploaded_by_line_uid: string;
  kind: TaskFileKind;
  note: string | null;
  created_at: string;
}

export type TaskFileKind = 'brief' | 'submission';

export interface TaskReminderRecord {
  id: string;
  task_id: string | null;
  task_item_id: string | null;
  remind_type: RemindType;
  remind_at: string;
  sent_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
}

export interface GroupMemberRecord {
  id: string;
  group_line_id: string;
  line_uid: string;
  display_name: string | null;
  picture_url: string | null;
  registered_at: string;
  /** Set by removeGroupMember() on a LINE `memberLeft` event; see migration 049. */
  removed_at: string | null;
}

/** Job: send one reminder round (textV2 mention + Flex card) for a task/item. */
export interface TaskReminderJob {
  type: 'task_reminder';
  taskId: string;
  /** null for single/recurring tasks whose reminders are task-level */
  itemId: string | null;
  remindType: RemindType;
  /** task_reminders row this job delivers — stamped sent_at/failed_at */
  reminderId: string;
}

/**
 * Job: roll a recurring task over to its next occurrence (self-scheduling —
 * fired at overdue+1h of the current round; resets assignee done marks, moves
 * global_deadline forward, schedules the next round's reminders + rollover).
 */
export interface TaskRecurNextJob {
  type: 'task_recur_next';
  taskId: string;
  /** ISO deadline of the round being closed — stale jobs (deadline moved) no-op */
  occurrence: string;
}

/**
 * Job: periodic self-heal for recurring tasks (repeatable). The rollover chain
 * is self-scheduling, so a task_recur_next job that dies (all attempts failed,
 * or Redis lost the delayed job) would otherwise freeze its task forever. The
 * sweep finds recurring tasks whose deadline+rollover-delay has passed with no
 * live rollover job and re-rolls them.
 */
export interface TaskRecurSweepJob {
  type: 'task_recur_sweep';
}

/**
 * Job: deliver ONE immediate task push (group announcement on create, the
 * ยกเลิกงาน notice on cancel, and the review-loop notices submit/approve/reject).
 *
 * These used to be fired inline from the HTTP route with a bare `pushMessage`.
 * They go through the queue now for two reasons:
 *
 *  1. Project rule — every LINE push is enqueued, never called from a request
 *     handler. A push is a metered third-party call; a request the user is
 *     waiting on must not block on it, and a failed one must not be lost.
 *  2. It puts ALL task pushes behind the ONE worker rate limiter (see
 *     createTaskReminderWorker), which is what keeps a burst of reminders and a
 *     burst of review notices from competing for the same LINE budget.
 *
 * `messages` is the LINE message array verbatim (text or Flex). It is typed
 * loosely here on purpose: the Flex builders live in the API package and this
 * shared package must not depend on them. BullMQ serialises the payload to JSON
 * either way, so nothing is lost.
 */
export interface TaskNotifyJob {
  type: 'task_notify';
  /** LINE destination: a group id for group tasks, a user id for personal ones. */
  to: string;
  messages: unknown[];
  /** Task this notice belongs to — for logging/idempotency only. */
  taskId: string;
  /** Free-text tag for logs: 'announce' | 'cancel' | 'submit' | 'approve' | 'reject'. */
  context: string;
}

export type TaskJob =
  | TaskReminderJob
  | TaskRecurNextJob
  | TaskRecurSweepJob
  | TaskNotifyJob;

/**
 * BullMQ queue for Google Sheets sync (migration 046) — its OWN queue, separate
 * from both file processing and task reminders. A Google outage backs up here
 * and nowhere else: a time-sensitive reminder must never wait behind a retrying
 * third-party HTTP call.
 */
export const SHEETS_QUEUE = 'nookeb-sheets-sync';

/**
 * Job: mirror one task into its owner's sheet. The payload deliberately carries
 * NO userId — the owner is resolved from the task at run time. Callers that
 * mutate a task (an assignee marking done, the creator editing) don't all know
 * the OWNER's user id, and resolving at enqueue time would mean either an extra
 * query in every route or a payload that's wrong half the time.
 */
export interface SheetsSyncJob {
  type: 'sheets_sync';
  taskId: string;
  /** 'delete' strikes the row through; it never removes it (audit trail). */
  action: 'upsert' | 'delete';
}

/**
 * Job: backfill every task the user has ALREADY created into their sheet.
 *
 * The opposite payload shape to SheetsSyncJob, and for the mirror-image reason:
 * this job is about a PERSON, not a task — it is triggered by connecting a
 * sheet, not by a task changing — so the user id is the only thing that
 * identifies the work. It carries no task ids because the set is resolved at
 * run time; a list captured at enqueue time would already be stale.
 */
export interface SheetsHistoricalJob {
  type: 'sheets_historical';
  userId: string;
}

export type SheetsJob = SheetsSyncJob | SheetsHistoricalJob;

// ---- DTOs (LIFF web ↔ API) ----

export interface TaskAssigneeDto {
  id: string;
  lineUid: string;
  displayName: string | null;
  pictureUrl: string | null;
  acceptedAt: string | null;
  doneAt: string | null;
  doneNote: string | null;
}

export interface TaskLinkDto {
  id: string;
  url: string;
  label: string | null;
}

export interface TaskItemDto {
  id: string;
  title: string;
  description: string | null;
  /** effective deadline (item deadline ?? task global_deadline) */
  deadline: string | null;
  status: TaskItemStatus;
  sortOrder: number;
  assignees: TaskAssigneeDto[];
  /** migration 045 — review loop */
  submittedAt: string | null;
  rejectedAt: string | null;
  rejectionNote: string | null;
  submissionNote: string | null;
}

/**
 * A task attachment as the LIFF/web sees it. `url` is a presigned GET (rule 5 —
 * binary is NEVER proxied through the API) and is minted per read, so it is
 * omitted from list payloads that don't need it.
 */
export interface TaskFileDto {
  id: string;
  fileId: string;
  taskItemId: string | null;
  name: string;
  size: number;
  mimeType: string;
  kind: TaskFileKind;
  uploadedByLineUid: string;
  createdAt: string;
  /** presigned download URL (1h) — null while the file row isn't 'ready' */
  url: string | null;
}

export interface TaskDto {
  id: string;
  /** NULL for personal tasks (migration 043) — see TaskRecord.group_line_id. */
  groupLineId: string | null;
  isPersonal: boolean;
  title: string;
  type: TaskType;
  globalDeadline: string | null;
  recurrenceRule: RecurrenceRule | null;
  status: TaskStatus;
  createdByLineUid: string;
  createdAt: string;
  /**
   * §4c "เตือนเฉพาะคนที่ยังไม่ส่งงาน" (migration 051). Exposed so the task detail
   * page can render the creator's checkbox in its CURRENT state rather than
   * guessing — a toggle that always renders unchecked silently loses the
   * setting the next time anyone saves the form. Non-optional with a `false`
   * default from toTaskDto: a missing column and an off toggle mean the same
   * thing to every reader.
   */
  notifyOnlyPending: boolean;
  items: TaskItemDto[];
  links: TaskLinkDto[];
  /**
   * Attachments (migration 045). Carried WITHOUT presigned urls (`url: null`)
   * on the task payload — minting one per file on every task read would burn
   * signing work nobody looks at. The LIFF fetches signed urls on demand from
   * GET /tasks/:id/files.
   */
  files: TaskFileDto[];
}

export interface GroupMemberDto {
  lineUid: string;
  displayName: string | null;
  pictureUrl: string | null;
}

export function toTaskAssigneeDto(row: TaskAssigneeRecord): TaskAssigneeDto {
  return {
    id: row.id,
    lineUid: row.line_uid,
    displayName: row.display_name,
    pictureUrl: row.picture_url,
    acceptedAt: row.accepted_at,
    doneAt: row.done_at,
    doneNote: row.done_note,
  };
}

export function toTaskLinkDto(row: TaskLinkRecord): TaskLinkDto {
  return { id: row.id, url: row.url, label: row.label };
}

export function toGroupMemberDto(row: GroupMemberRecord): GroupMemberDto {
  return {
    lineUid: row.line_uid,
    displayName: row.display_name,
    pictureUrl: row.picture_url,
  };
}
