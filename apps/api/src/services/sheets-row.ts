import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import {
  effectiveDeadline,
  type TaskItemWithAssignees,
  type TaskWithDetails,
} from './task.service';
import type { TaskUrgency } from '@nookeb/shared';
import type { SheetTaskRow } from './google-sheets.service';
import { progressBar, URGENCIES } from './sheets-workspace.service';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * task → sheet rows. Extracted from sheetsWorker so the historical backfill
 * (sheets-historical.service.ts) produces byte-identical rows to the live sync:
 * a backfilled row and a synced row must be indistinguishable, or the two paths
 * would disagree about a date format or a status label and the workspace views
 * — every one of which reads the master by exact string match — would split a
 * single status into two buckets.
 *
 * ROW MODEL (since 2026-08-01): a `single`/`recurring` task is ONE row keyed by
 * its task id — unchanged, so every row the sync ever wrote keeps matching. A
 * `multi` task is ONE ROW PER SUB-ITEM, keyed `{taskId}-{itemId}` (see
 * taskRowKey), because each sub-item carries its own deadline, assignees and
 * review state and flattening them into one row lost all three. The composite
 * key is what lets a status change target exactly the right row, and it can
 * never collide with a bare task UUID (different length) or the add-on's
 * LOCAL-… ids.
 */

const BANGKOK_TZ = 'Asia/Bangkok';

/**
 * The value written to the hidden รหัสงาน column — the row's identity.
 * Single/recurring rows keep the bare task id (backwards compatible with every
 * sheet already in the field); a multi task's rows are per-item.
 */
export function taskRowKey(taskId: string, itemId?: string | null): string {
  return itemId ? `${taskId}-${itemId}` : taskId;
}

/**
 * Canonical urgency key (migration 048) → the workspace's column-K label.
 * URGENCIES is ordered most→least urgent, same as the key order — asserted in
 * the tests so the arrays can't silently drift apart.
 */
export function urgencyLabel(urgency: TaskUrgency | null | undefined): string {
  const index: Record<TaskUrgency, number> = { urgent_max: 0, urgent: 1, normal: 2, relaxed: 3 };
  return urgency ? (URGENCIES[index[urgency]] ?? '') : '';
}

/** Column E / I display format. Bangkok wall clock, never UTC. */
export function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const d = dayjs(iso);
  return d.isValid() ? d.tz(BANGKOK_TZ).format('DD/MM/YYYY HH:mm') : '';
}

/** Newest of a set of nullable ISO stamps, or null when none exist. */
function newest(stamps: (string | null)[]): string | null {
  const real = stamps.filter((s): s is string => s !== null);
  if (real.length === 0) return null;
  return real.reduce((a, b) => (new Date(a).getTime() >= new Date(b).getTime() ? a : b));
}

function itemStamps(item: TaskItemWithAssignees): (string | null)[] {
  return [
    item.submitted_at,
    item.rejected_at,
    ...item.assignees.flatMap((a) => [a.done_at, a.accepted_at]),
  ];
}

/**
 * Newest activity on the task — same derivation as the .xlsx export: there is
 * no updated_at column, so it comes from the stamps that already exist.
 */
export function resolveUpdatedAt(task: TaskWithDetails): string | null {
  return newest(task.items.flatMap(itemStamps)) ?? task.created_at;
}

/** Per-item counterpart of resolveUpdatedAt, for a multi task's rows. */
export function resolveItemUpdatedAt(task: TaskWithDetails, item: TaskItemWithAssignees): string | null {
  return newest(itemStamps(item)) ?? task.created_at;
}

/**
 * When the task finished, or null while it is still open. `done` is a task-level
 * status, so the moment it flipped is the newest per-assignee done_at — the same
 * stamps resolveUpdatedAt walks. This is what the workspace's analytics measure
 * "time to complete" against, so it has to be the real completion instant, not
 * the sync time.
 */
export function resolveDoneAt(task: TaskWithDetails): string | null {
  if (task.status !== 'done') return null;
  return (
    newest(task.items.flatMap((i) => i.assignees.map((a) => a.done_at))) ?? task.created_at
  );
}

/** Per-item completion instant — null until the ITEM is done. */
export function resolveItemDoneAt(task: TaskWithDetails, item: TaskItemWithAssignees): string | null {
  if (item.status !== 'done') return null;
  return newest(item.assignees.map((a) => a.done_at)) ?? task.created_at;
}

/** Items whose every assignee is done, over items total → the progress column. */
export function resolveProgress(task: TaskWithDetails): string {
  const total = task.items.length;
  if (total === 0) return '';
  const done = task.items.filter(
    (i) => i.assignees.length > 0 && i.assignees.every((a) => a.done_at !== null),
  ).length;
  return progressBar(done, total);
}

/** An item row's progress: assignees finished over assignees total. */
export function resolveItemProgress(item: TaskItemWithAssignees): string {
  const total = item.assignees.length;
  if (total === 0) return '';
  const done = item.assignees.filter((a) => a.done_at !== null).length;
  return progressBar(done, total);
}

/** Attached links and file names, one per line — plain text, never presigned
 * URLs: those expire in an hour and the sheet outlives them. */
export function resolveLinks(task: TaskWithDetails): string {
  const links = task.links.map((l) => l.url);
  const files = task.files.map((f) => `📎 ${f.file.display_name || f.file.original_name}`);
  return [...links, ...files].join('\n');
}

/** The one row a single/recurring task maps to — identical to the pre-B layout. */
function taskLevelRow(task: TaskWithDetails, createdBy: string, deleted: boolean): SheetTaskRow {
  const assignees = [
    ...new Set(
      task.items.flatMap((i) => i.assignees.map((a) => a.display_name || 'สมาชิก')),
    ),
  ];
  const deadline =
    task.global_deadline ?? (task.items[0] ? effectiveDeadline(task, task.items[0]) : null);

  return {
    key: taskRowKey(task.id),
    taskId: task.id,
    urgency: urgencyLabel(task.urgency),
    title: task.title,
    description: task.items[0]?.description ?? '',
    type: task.type,
    deadline: formatWhen(deadline),
    createdBy,
    assignees: assignees.join(', '),
    status: task.status,
    updatedAt: formatWhen(resolveUpdatedAt(task)),
    deleted,
    progress: resolveProgress(task),
    links: resolveLinks(task),
    createdAt: task.created_at,
    doneAt: resolveDoneAt(task),
    deadlineAt: deadline,
  };
}

/** One of a multi task's rows: the sub-item's OWN deadline, assignees, state. */
function itemLevelRow(
  task: TaskWithDetails,
  item: TaskItemWithAssignees,
  createdBy: string,
  deleted: boolean,
): SheetTaskRow {
  const deadline = effectiveDeadline(task, item);
  return {
    key: taskRowKey(task.id, item.id),
    taskId: task.id,
    urgency: urgencyLabel(task.urgency),
    title: `${task.title} - ${item.title}`,
    description: item.description ?? '',
    type: task.type,
    deadline: formatWhen(deadline),
    createdBy,
    assignees: [...new Set(item.assignees.map((a) => a.display_name || 'สมาชิก'))].join(', '),
    // The ITEM's status, not the task's — this is the whole point of the
    // per-item rows: ตีกลับ on one sub-item must not paint the others.
    status: item.status,
    updatedAt: formatWhen(resolveItemUpdatedAt(task, item)),
    deleted,
    progress: resolveItemProgress(item),
    links: resolveLinks(task),
    createdAt: task.created_at,
    doneAt: resolveItemDoneAt(task, item),
    deadlineAt: deadline,
  };
}

/**
 * A task's complete set of sheet rows. `multi` → one per sub-item; everything
 * else → exactly one, keyed and shaped exactly as before Part B.
 */
export function toSheetRows(
  task: TaskWithDetails,
  createdBy: string,
  deleted: boolean,
): SheetTaskRow[] {
  if (task.type === 'multi' && task.items.length > 0) {
    return task.items.map((item) => itemLevelRow(task, item, createdBy, deleted));
  }
  return [taskLevelRow(task, createdBy, deleted)];
}
