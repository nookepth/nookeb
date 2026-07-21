import type { TaskDto } from '@nookeb/shared';

export const THAI_MONTHS = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
];

export function formatDeadline(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

/** Human Thai deadline: วันนี้/พรุ่งนี้/เมื่อวาน + เวลา, "อีก N วัน" /
 * "N วันที่แล้ว" within a week, absolute date beyond that. */
export function formatRelativeDeadline(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);
  if (dayDiff === 0) return `วันนี้ ${time}`;
  if (dayDiff === 1) return `พรุ่งนี้ ${time}`;
  if (dayDiff === -1) return `เมื่อวาน ${time}`;
  if (dayDiff > 1 && dayDiff <= 7) return `อีก ${dayDiff} วัน (${d.getDate()} ${THAI_MONTHS[d.getMonth()]})`;
  if (dayDiff < -1 && dayDiff >= -7) return `${Math.abs(dayDiff)} วันที่แล้ว`;
  return `${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${time}`;
}

/** '' = normal, 'urgent' ≤ 24h left, 'overdue' past. */
export function urgency(iso: string | null): '' | 'urgent' | 'overdue' {
  if (!iso) return '';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return 'overdue';
  if (diff <= 24 * 60 * 60 * 1000) return 'urgent';
  return '';
}

/** Progress: done assignee-slots / total assignee-slots across live items. */
export function taskProgress(task: TaskDto): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const item of task.items) {
    if (item.status === 'cancelled') continue;
    for (const a of item.assignees) {
      total += 1;
      if (a.doneAt) done += 1;
    }
  }
  return { done, total };
}

/** Task's effective deadline: global one, else the earliest live-item deadline
 * (item.deadline is already item ?? global per the DTO contract). */
export function effectiveDeadline(task: TaskDto): string | null {
  if (task.globalDeadline) return task.globalDeadline;
  let earliest: string | null = null;
  for (const item of task.items) {
    if (item.status === 'cancelled' || !item.deadline) continue;
    if (!earliest || item.deadline < earliest) earliest = item.deadline;
  }
  return earliest;
}

/** Overdue = deadline passed AND the task is still live (not done/cancelled). */
export function isOverdue(task: TaskDto): boolean {
  if (task.status === 'done' || task.status === 'cancelled') return false;
  const d = effectiveDeadline(task);
  return d !== null && new Date(d).getTime() < Date.now();
}

/** Best-available completion time: the latest assignee doneAt (tasks carry no
 * completedAt column, so this is the closest client-derivable signal). */
export function completionTime(task: TaskDto): string | null {
  let latest: string | null = null;
  for (const item of task.items) {
    for (const a of item.assignees) {
      if (a.doneAt && (!latest || a.doneAt > latest)) latest = a.doneAt;
    }
  }
  return latest;
}
