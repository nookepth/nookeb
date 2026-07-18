import type { SupabaseClient } from '@supabase/supabase-js';
import type { Redis } from 'ioredis';
import type {
  GroupMemberRecord,
  RemindType,
  TaskAssigneeRecord,
  TaskDto,
  TaskItemRecord,
  TaskRecord,
  TaskReminderRecord,
} from '@nookeb/shared';
import { toTaskAssigneeDto as assigneeDto } from '@nookeb/shared';
import { getChatMemberIds, getChatMemberProfile } from './line.service';

/**
 * ระบบตามงาน (Task Manager) data access — migration 036. Soft-delete only
 * (rule 6 spirit): tasks/items get deleted_at, never a hard DELETE; reminder
 * rows are cancelled via cancelled_at, never removed.
 *
 * Tenant model: group_line_id is the boundary. Every route-level caller must be
 * a registered group_members row for the task's group (checked explicitly —
 * the service role bypasses RLS, so these checks are the real guard).
 */

// ---- group members ----

export async function upsertGroupMember(
  supabase: SupabaseClient,
  groupLineId: string,
  lineUid: string,
  displayName?: string | null,
  pictureUrl?: string | null,
): Promise<void> {
  // NULL profile fields are omitted from the payload: a transient LINE profile
  // failure (webhook auto-upsert passes null then) must not wipe a name/avatar
  // the roster already resolved — the conflict-update only touches provided
  // columns, so existing values survive.
  const { error } = await supabase.from('group_members').upsert(
    {
      group_line_id: groupLineId,
      line_uid: lineUid,
      ...(displayName != null ? { display_name: displayName } : {}),
      ...(pictureUrl != null ? { picture_url: pictureUrl } : {}),
      registered_at: new Date().toISOString(),
    },
    { onConflict: 'group_line_id,line_uid' },
  );
  if (error) throw error;
}

export async function listGroupMembers(
  supabase: SupabaseClient,
  groupLineId: string,
): Promise<GroupMemberRecord[]> {
  const { data, error } = await supabase
    .from('group_members')
    .select('*')
    .eq('group_line_id', groupLineId)
    .order('registered_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as GroupMemberRecord[];
}

export async function isGroupMember(
  supabase: SupabaseClient,
  groupLineId: string,
  lineUid: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('group_members')
    .select('id')
    .eq('group_line_id', groupLineId)
    .eq('line_uid', lineUid)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

/**
 * Membership check that auto-enrolls the caller. Trust model: a LINE group id
 * is an unguessable bearer capability (delivered only inside the group, same
 * model as share links), so possession IS the membership proof — no extra LINE
 * API call is needed, and none is reliable anyway.
 *
 * We deliberately do NOT gate on LINE's group-scoped member endpoint: it 404s
 * for legitimate members who haven't messaged since the bot joined, and for
 * unverified OAs, so gating on it locked real members out of their own group
 * (the mobile "ยังไม่เห็นเราในกลุ่มนี้เลยน้า" bug). The signed LIFF session already
 * proves WHO the caller is; the group id in the request proves WHICH group they
 * hold the capability to. That is sufficient.
 *
 * Always returns true (enrolls) unless the DB write itself fails (throws). The
 * boolean return is kept for callers' defensive guards + canView.
 */
export async function ensureGroupMember(
  supabase: SupabaseClient,
  groupLineId: string,
  lineUid: string,
): Promise<boolean> {
  if (await isGroupMember(supabase, groupLineId, lineUid)) return true;
  // Display name/avatar only — best-effort, non-strict (null is fine; the
  // roster sync + webhook auto-upsert re-resolve NULL names later). This fetch
  // is NOT a membership gate; the capability above already granted access.
  const profile = await getChatMemberProfile(groupLineId, lineUid);
  await upsertGroupMember(
    supabase,
    groupLineId,
    lineUid,
    profile?.displayName ?? null,
    profile?.pictureUrl ?? null,
  );
  return true;
}

const ROSTER_SYNC_TTL_SECONDS = 600; // at most one LINE sync per group per 10 min
const ROSTER_SYNC_MAX_PROFILE_FETCHES = 50;
const ROSTER_SYNC_CONCURRENCY = 5;

/**
 * Best-effort roster fill from LINE at read time, so the assignee picker lists
 * the whole group without anyone typing /register:
 *  1. members/ids (verified/premium OA) → resolve + upsert every member the
 *     roster is missing, and re-resolve rows whose display_name is still NULL;
 *  2. when LINE denies the id list (unverified OA), just re-resolve the
 *     NULL-name rows via the group-scoped profile endpoint — new members keep
 *     arriving through the webhook's message-driven auto-upsert.
 * Throttled per group via Redis, EXCEPT when the roster is empty (a first open
 * must not stare at a blank list for 10 minutes). Never throws — the picker
 * still renders whatever the roster already has.
 */
export async function syncGroupRoster(
  supabase: SupabaseClient,
  redis: Redis,
  groupLineId: string,
): Promise<void> {
  try {
    const existing = await listGroupMembers(supabase, groupLineId);
    const throttled =
      (await redis.set(
        `task:roster-sync:${groupLineId}`,
        '1',
        'EX',
        ROSTER_SYNC_TTL_SECONDS,
        'NX',
      )) === null;
    if (throttled && existing.length > 0) return;

    const known = new Map(existing.map((m) => [m.line_uid, m]));
    const ids = await getChatMemberIds(groupLineId);
    const targets =
      ids !== null
        ? ids.filter((uid) => !known.has(uid) || known.get(uid)!.display_name === null)
        : existing.filter((m) => m.display_name === null).map((m) => m.line_uid);

    const queue = targets.slice(0, ROSTER_SYNC_MAX_PROFILE_FETCHES);
    for (let i = 0; i < queue.length; i += ROSTER_SYNC_CONCURRENCY) {
      await Promise.all(
        queue.slice(i, i + ROSTER_SYNC_CONCURRENCY).map(async (uid) => {
          const profile = await getChatMemberProfile(groupLineId, uid);
          // No resolvable profile → leave them off/as-is; a NULL-name row
          // would only render as a useless "สมาชิก" entry in the picker.
          if (!profile) return;
          await upsertGroupMember(
            supabase,
            groupLineId,
            uid,
            profile.displayName,
            profile.pictureUrl ?? null,
          );
        }),
      );
    }
  } catch (err) {
    console.warn(`[TASK] roster sync failed for group ${groupLineId}:`, err);
  }
}

// ---- tasks ----

export interface CreateTaskItemInput {
  title: string;
  description: string | null;
  deadline: string | null; // ISO; null = inherit global
  assignees: { lineUid: string; displayName: string | null; pictureUrl: string | null }[];
}

export interface CreateTaskInput {
  spaceId: string | null;
  groupLineId: string;
  title: string;
  type: TaskRecord['type'];
  globalDeadline: string | null;
  recurrenceRule: TaskRecord['recurrence_rule'];
  createdByLineUid: string;
  items: CreateTaskItemInput[];
}

export interface TaskItemWithAssignees extends TaskItemRecord {
  assignees: TaskAssigneeRecord[];
}

export interface TaskWithDetails extends TaskRecord {
  items: TaskItemWithAssignees[];
}

/**
 * Insert task + items + assignees. No multi-statement transaction is available
 * through the Supabase client — on a mid-way failure we soft-cancel the shell
 * task so a half-created task can never be announced or reminded.
 */
export async function createTaskWithItems(
  supabase: SupabaseClient,
  input: CreateTaskInput,
): Promise<TaskWithDetails> {
  const { data: task, error: taskErr } = await supabase
    .from('tasks')
    .insert({
      space_id: input.spaceId,
      group_line_id: input.groupLineId,
      title: input.title,
      type: input.type,
      global_deadline: input.globalDeadline,
      recurrence_rule: input.recurrenceRule,
      created_by_line_uid: input.createdByLineUid,
    })
    .select('*')
    .single();
  if (taskErr) throw taskErr;
  const taskRecord = task as TaskRecord;

  try {
    const itemRows = input.items.map((item, i) => ({
      task_id: taskRecord.id,
      title: item.title,
      description: item.description,
      deadline: item.deadline,
      sort_order: i,
    }));
    const { data: items, error: itemErr } = await supabase
      .from('task_items')
      .insert(itemRows)
      .select('*');
    if (itemErr) throw itemErr;
    const itemRecords = (items ?? []) as TaskItemRecord[];
    // .insert() preserves input order; map assignees onto rows by sort_order
    itemRecords.sort((a, b) => a.sort_order - b.sort_order);

    const assigneeRows = itemRecords.flatMap((row) =>
      input.items[row.sort_order]!.assignees.map((a) => ({
        task_item_id: row.id,
        line_uid: a.lineUid,
        display_name: a.displayName,
        picture_url: a.pictureUrl,
      })),
    );
    const { data: assignees, error: assigneeErr } = await supabase
      .from('task_assignees')
      .insert(assigneeRows)
      .select('*');
    if (assigneeErr) throw assigneeErr;
    const assigneeRecords = (assignees ?? []) as TaskAssigneeRecord[];

    return {
      ...taskRecord,
      items: itemRecords.map((row) => ({
        ...row,
        assignees: assigneeRecords.filter((a) => a.task_item_id === row.id),
      })),
    };
  } catch (err) {
    // Soft-cancel the shell so nothing downstream ever sees a half-built task.
    await supabase
      .from('tasks')
      .update({ status: 'cancelled', deleted_at: new Date().toISOString() })
      .eq('id', taskRecord.id);
    throw err;
  }
}

export async function getTaskWithDetails(
  supabase: SupabaseClient,
  taskId: string,
): Promise<TaskWithDetails | null> {
  const { data: task, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('id', taskId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!task) return null;

  const { data: items, error: itemErr } = await supabase
    .from('task_items')
    .select('*')
    .eq('task_id', taskId)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true });
  if (itemErr) throw itemErr;
  const itemRecords = (items ?? []) as TaskItemRecord[];

  const itemIds = itemRecords.map((i) => i.id);
  let assigneeRecords: TaskAssigneeRecord[] = [];
  if (itemIds.length > 0) {
    const { data: assignees, error: assigneeErr } = await supabase
      .from('task_assignees')
      .select('*')
      .in('task_item_id', itemIds);
    if (assigneeErr) throw assigneeErr;
    assigneeRecords = (assignees ?? []) as TaskAssigneeRecord[];
  }

  return {
    ...(task as TaskRecord),
    items: itemRecords.map((row) => ({
      ...row,
      assignees: assigneeRecords.filter((a) => a.task_item_id === row.id),
    })),
  };
}

/**
 * Every non-deleted task the user has a stake in — either they created it, or
 * they're an assignee of one of its items — across ALL their groups. Powers the
 * web dashboard "งานของฉัน" view (user-scoped, no single group boundary).
 * Capped so a heavy user can't make this unbounded; newest deadline first.
 */
export async function listTasksForUser(
  supabase: SupabaseClient,
  lineUid: string,
  cap = 100,
): Promise<TaskWithDetails[]> {
  // Tasks the user created.
  const { data: createdRows, error: createdErr } = await supabase
    .from('tasks')
    .select('id')
    .eq('created_by_line_uid', lineUid)
    .is('deleted_at', null);
  if (createdErr) throw createdErr;

  // Tasks the user is assigned to (assignee → item → task).
  const { data: assigneeRows, error: assigneeErr } = await supabase
    .from('task_assignees')
    .select('task_item_id')
    .eq('line_uid', lineUid);
  if (assigneeErr) throw assigneeErr;

  const itemIds = [...new Set((assigneeRows ?? []).map((r) => (r as { task_item_id: string }).task_item_id))];
  let assignedTaskIds: string[] = [];
  if (itemIds.length > 0) {
    const { data: itemRows, error: itemErr } = await supabase
      .from('task_items')
      .select('task_id')
      .in('id', itemIds)
      .is('deleted_at', null);
    if (itemErr) throw itemErr;
    assignedTaskIds = (itemRows ?? []).map((r) => (r as { task_id: string }).task_id);
  }

  const taskIds = [
    ...new Set([
      ...(createdRows ?? []).map((r) => (r as { id: string }).id),
      ...assignedTaskIds,
    ]),
  ].slice(0, cap);
  if (taskIds.length === 0) return [];

  const details = await Promise.all(taskIds.map((id) => getTaskWithDetails(supabase, id)));
  const tasks = details.filter((t): t is TaskWithDetails => t !== null);

  // Newest activity first: nearest live deadline, then created_at.
  tasks.sort((a, b) => {
    const da = a.global_deadline ? new Date(a.global_deadline).getTime() : Infinity;
    const db = b.global_deadline ? new Date(b.global_deadline).getTime() : Infinity;
    if (da !== db) return da - db;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
  return tasks;
}

export async function updateTask(
  supabase: SupabaseClient,
  taskId: string,
  patch: { title?: string; global_deadline?: string; status?: TaskRecord['status'] },
): Promise<void> {
  const { error } = await supabase.from('tasks').update(patch).eq('id', taskId);
  if (error) throw error;
}

/** Effective deadline for an item: its own, else the task's global one. */
export function effectiveDeadline(task: TaskRecord, item: TaskItemRecord): string | null {
  return item.deadline ?? task.global_deadline;
}

// ---- done / accept marks ----

/** Stamp done_at for one assignee. Returns false when the caller isn't an
 * assignee of the item (or is already done — idempotent success). */
export async function markAssigneeDone(
  supabase: SupabaseClient,
  itemId: string,
  lineUid: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('task_assignees')
    .update({ done_at: new Date().toISOString() })
    .eq('task_item_id', itemId)
    .eq('line_uid', lineUid)
    .is('done_at', null)
    .select('id');
  if (error) throw error;
  if ((data ?? []).length > 0) return true;
  // Distinguish "already done" (idempotent true) from "not an assignee" (false)
  const { data: existing, error: findErr } = await supabase
    .from('task_assignees')
    .select('id')
    .eq('task_item_id', itemId)
    .eq('line_uid', lineUid)
    .maybeSingle();
  if (findErr) throw findErr;
  return existing !== null;
}

export async function markAssigneeAccepted(
  supabase: SupabaseClient,
  itemId: string,
  lineUid: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('task_assignees')
    .update({ accepted_at: new Date().toISOString() })
    .eq('task_item_id', itemId)
    .eq('line_uid', lineUid)
    .is('accepted_at', null)
    .select('id');
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * Roll item/task statuses up from assignee done marks: an item whose assignees
 * are all done becomes 'done'; a task whose live items are all done becomes
 * 'done'. Returns whether the whole TASK just completed (caller then cancels
 * outstanding reminders).
 */
export async function rollUpCompletion(
  supabase: SupabaseClient,
  taskId: string,
): Promise<{ taskDone: boolean }> {
  const details = await getTaskWithDetails(supabase, taskId);
  if (!details) return { taskDone: false };

  for (const item of details.items) {
    const allDone =
      item.assignees.length > 0 && item.assignees.every((a) => a.done_at !== null);
    if (allDone && item.status !== 'done') {
      const { error } = await supabase
        .from('task_items')
        .update({ status: 'done' })
        .eq('id', item.id);
      if (error) throw error;
      item.status = 'done';
    }
  }

  const taskDone =
    details.items.length > 0 && details.items.every((i) => i.status === 'done');
  if (taskDone && details.status !== 'done' && details.type !== 'recurring') {
    await updateTask(supabase, taskId, { status: 'done' });
  } else if (!taskDone && details.status === 'pending') {
    const anyDone = details.items.some(
      (i) => i.status === 'done' || i.assignees.some((a) => a.done_at !== null),
    );
    if (anyDone) await updateTask(supabase, taskId, { status: 'in_progress' });
  }
  // A recurring task never reaches 'done' — the round resets at rollover.
  return { taskDone: taskDone && details.type !== 'recurring' };
}

/** Reset a recurring task's round: clear done/accept marks, items → pending. */
export async function resetRecurringRound(supabase: SupabaseClient, taskId: string): Promise<void> {
  const { data: items, error } = await supabase
    .from('task_items')
    .select('id')
    .eq('task_id', taskId)
    .is('deleted_at', null);
  if (error) throw error;
  const itemIds = ((items ?? []) as { id: string }[]).map((i) => i.id);
  if (itemIds.length === 0) return;

  const { error: assigneeErr } = await supabase
    .from('task_assignees')
    .update({ done_at: null, accepted_at: null })
    .in('task_item_id', itemIds);
  if (assigneeErr) throw assigneeErr;

  const { error: itemErr } = await supabase
    .from('task_items')
    .update({ status: 'pending' })
    .in('id', itemIds);
  if (itemErr) throw itemErr;
}

// ---- reminder rows ----

export interface ReminderInsert {
  task_id: string;
  task_item_id: string | null;
  remind_type: RemindType;
  remind_at: string;
}

export async function insertReminders(
  supabase: SupabaseClient,
  rows: ReminderInsert[],
): Promise<TaskReminderRecord[]> {
  if (rows.length === 0) return [];
  const { data, error } = await supabase.from('task_reminders').insert(rows).select('*');
  if (error) throw error;
  return (data ?? []) as TaskReminderRecord[];
}

export async function getReminder(
  supabase: SupabaseClient,
  reminderId: string,
): Promise<TaskReminderRecord | null> {
  const { data, error } = await supabase
    .from('task_reminders')
    .select('*')
    .eq('id', reminderId)
    .maybeSingle();
  if (error) throw error;
  return (data as TaskReminderRecord | null) ?? null;
}

/** Reminder rows still awaiting delivery (not sent/failed/cancelled). */
export async function listOutstandingReminders(
  supabase: SupabaseClient,
  taskId: string,
): Promise<TaskReminderRecord[]> {
  const { data, error } = await supabase
    .from('task_reminders')
    .select('*')
    .eq('task_id', taskId)
    .is('sent_at', null)
    .is('failed_at', null)
    .is('cancelled_at', null);
  if (error) throw error;
  return (data ?? []) as TaskReminderRecord[];
}

export async function stampReminder(
  supabase: SupabaseClient,
  reminderId: string,
  field: 'sent_at' | 'failed_at' | 'cancelled_at',
): Promise<void> {
  const { error } = await supabase
    .from('task_reminders')
    .update({ [field]: new Date().toISOString() })
    .eq('id', reminderId);
  if (error) throw error;
}

// ---- DTO ----

export function toTaskDto(task: TaskWithDetails): TaskDto {
  return {
    id: task.id,
    groupLineId: task.group_line_id,
    title: task.title,
    type: task.type,
    globalDeadline: task.global_deadline,
    recurrenceRule: task.recurrence_rule,
    status: task.status,
    createdByLineUid: task.created_by_line_uid,
    createdAt: task.created_at,
    items: task.items.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      deadline: effectiveDeadline(task, item),
      status: item.status,
      sortOrder: item.sort_order,
      assignees: item.assignees.map(assigneeDto),
    })),
  };
}
