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
export type RemindType = '3_days' | '1_day' | '3_hours' | 'overdue';

/** Ordered mapping of reminder type → offset from the deadline (minutes;
 * negative = before). Shared so the scheduler and .ics VALARMs agree. */
export const REMIND_OFFSETS_MINUTES: Record<RemindType, number> = {
  '3_days': -3 * 24 * 60,
  '1_day': -24 * 60,
  '3_hours': -3 * 60,
  overdue: 60,
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
  group_line_id: string;
  title: string;
  type: TaskType;
  global_deadline: string | null;
  recurrence_rule: RecurrenceRule | null;
  status: TaskStatus;
  created_by_line_uid: string;
  created_at: string;
  deleted_at: string | null;
}

export interface TaskItemRecord {
  id: string;
  task_id: string;
  title: string;
  description: string | null;
  deadline: string | null;
  status: TaskStatus;
  sort_order: number;
  deleted_at: string | null;
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

export type TaskJob = TaskReminderJob | TaskRecurNextJob | TaskRecurSweepJob;

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
  status: TaskStatus;
  sortOrder: number;
  assignees: TaskAssigneeDto[];
}

export interface TaskDto {
  id: string;
  groupLineId: string;
  title: string;
  type: TaskType;
  globalDeadline: string | null;
  recurrenceRule: RecurrenceRule | null;
  status: TaskStatus;
  createdByLineUid: string;
  createdAt: string;
  items: TaskItemDto[];
  links: TaskLinkDto[];
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
