import type { TaskDto } from '@nookeb/shared';
import { completionTime, effectiveDeadline, isOverdue } from './taskUtils';

/* ---- client-side preferences (no DB — survives per the spec'd storage) ---- */

export type TaskFilter = 'all' | 'group' | 'personal' | 'assigned' | 'created';
export type TaskSort = 'deadline' | 'created' | 'title';
export type ViewMode = 'list' | 'calendar';

export const FILTER_LABEL: Record<TaskFilter, string> = {
  all: 'ทั้งหมด',
  group: 'งานกลุ่ม',
  personal: 'งานส่วนตัว',
  assigned: 'มอบหมายให้ฉัน',
  created: 'ฉันสร้าง',
};

export const SORT_LABEL: Record<TaskSort, string> = {
  deadline: 'ใกล้ deadline',
  created: 'สร้างล่าสุด',
  title: 'ชื่อ ก-ฮ',
};

const FILTER_SORT_KEY = 'nookeb.tasks.filterSort';
const VIEW_KEY = 'nookeb.tasks.view';
const FOCUS_KEY = 'nookeb.tasks.focusCollapsed';
const FEED_KEY = 'nookeb.tasks.feedCollapsed';
const PIN_KEY = 'nookeb.tasks.pinned';

/** sessionStorage — survives tab switches within the visit (per spec). */
export function loadFilterSort(): { filter: TaskFilter; sort: TaskSort } {
  try {
    const raw = sessionStorage.getItem(FILTER_SORT_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { filter?: string; sort?: string };
      const filter = (Object.keys(FILTER_LABEL) as TaskFilter[]).find((f) => f === p.filter) ?? 'all';
      const sort = (Object.keys(SORT_LABEL) as TaskSort[]).find((s) => s === p.sort) ?? 'deadline';
      return { filter, sort };
    }
  } catch {
    /* storage unavailable — defaults */
  }
  return { filter: 'all', sort: 'deadline' };
}

export function saveFilterSort(filter: TaskFilter, sort: TaskSort): void {
  try {
    sessionStorage.setItem(FILTER_SORT_KEY, JSON.stringify({ filter, sort }));
  } catch {
    /* ignore */
  }
}

export function loadViewMode(): ViewMode {
  try {
    return sessionStorage.getItem(VIEW_KEY) === 'calendar' ? 'calendar' : 'list';
  } catch {
    return 'list';
  }
}
export function saveViewMode(v: ViewMode): void {
  try {
    sessionStorage.setItem(VIEW_KEY, v);
  } catch {
    /* ignore */
  }
}

export function loadCollapsed(which: 'focus' | 'feed'): boolean {
  try {
    return sessionStorage.getItem(which === 'focus' ? FOCUS_KEY : FEED_KEY) === '1';
  } catch {
    return false;
  }
}
export function saveCollapsed(which: 'focus' | 'feed', collapsed: boolean): void {
  try {
    sessionStorage.setItem(which === 'focus' ? FOCUS_KEY : FEED_KEY, collapsed ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** localStorage — pins persist across visits (per spec). */
export function loadPins(): string[] {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    /* ignore */
  }
  return [];
}
export function savePins(ids: string[]): void {
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify(ids));
  } catch {
    /* ignore */
  }
}

/* ---- pure derivations over the already-loaded /tasks/mine payload ---- */

/** Local calendar-day key (device timezone — same clock the deadlines render in). */
export function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function applyFilter(tasks: TaskDto[], filter: TaskFilter, viewerUid: string): TaskDto[] {
  switch (filter) {
    case 'group':
      return tasks.filter((t) => !t.isPersonal);
    case 'personal':
      return tasks.filter((t) => t.isPersonal);
    case 'assigned':
      return tasks.filter((t) => t.items.some((i) => i.assignees.some((a) => a.lineUid === viewerUid)));
    case 'created':
      return tasks.filter((t) => t.createdByLineUid === viewerUid);
    default:
      return tasks;
  }
}

export function applySort(tasks: TaskDto[], sort: TaskSort): TaskDto[] {
  const copy = [...tasks];
  if (sort === 'created') {
    copy.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  } else if (sort === 'title') {
    copy.sort((a, b) => a.title.localeCompare(b.title, 'th'));
  } else {
    copy.sort((a, b) => {
      const da = effectiveDeadline(a);
      const db = effectiveDeadline(b);
      if (da === null && db === null) return 0;
      if (da === null) return 1;
      if (db === null) return -1;
      return da < db ? -1 : da > db ? 1 : 0;
    });
  }
  return copy;
}

/** Pinned tasks float to the top; relative order inside each half is kept. */
export function pinnedFirst(tasks: TaskDto[], pins: string[]): TaskDto[] {
  if (pins.length === 0) return tasks;
  const set = new Set(pins);
  return [...tasks.filter((t) => set.has(t.id)), ...tasks.filter((t) => !set.has(t.id))];
}

/** Live tasks due today (device day) or already overdue — the focus set. */
export function focusTasks(tasks: TaskDto[]): { due: TaskDto[]; overdueCount: number } {
  const todayK = dayKey(new Date());
  const due: TaskDto[] = [];
  let overdueCount = 0;
  for (const t of tasks) {
    if (t.status === 'done' || t.status === 'cancelled') continue;
    const dl = effectiveDeadline(t);
    if (!dl) continue;
    const over = isOverdue(t);
    if (over || dayKey(new Date(dl)) === todayK) {
      due.push(t);
      if (over) overdueCount += 1;
    }
  }
  due.sort((a, b) => {
    const da = effectiveDeadline(a) ?? '';
    const db = effectiveDeadline(b) ?? '';
    return da < db ? -1 : da > db ? 1 : 0;
  });
  return { due, overdueCount };
}

/**
 * Consecutive days (ending today or yesterday) on which the viewer completed
 * at least one of their assignments ON TIME (doneAt ≤ its deadline; items
 * without a deadline count as on time). A day with no on-time completion
 * breaks the chain — but an empty TODAY doesn't break it yet.
 */
export function computeStreak(tasks: TaskDto[], viewerUid: string): number {
  const onTimeDays = new Set<string>();
  for (const t of tasks) {
    for (const item of t.items) {
      for (const a of item.assignees) {
        if (a.lineUid !== viewerUid || !a.doneAt) continue;
        if (!item.deadline || new Date(a.doneAt).getTime() <= new Date(item.deadline).getTime()) {
          onTimeDays.add(dayKey(new Date(a.doneAt)));
        }
      }
    }
  }
  if (onTimeDays.size === 0) return 0;
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  if (!onTimeDays.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1); // today still open
  let streak = 0;
  while (onTimeDays.has(dayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/**
 * This month's completion ratio for the ring: done = tasks completed this
 * month; total = those + tasks still live with a deadline this month (or
 * already overdue — they still demand attention this month).
 */
export function monthProgress(tasks: TaskDto[]): { done: number; total: number } {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const ms = monthStart.getTime();
  const nextMonth = new Date(monthStart);
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  const me = nextMonth.getTime();
  let done = 0;
  let total = 0;
  for (const t of tasks) {
    if (t.status === 'done') {
      const ct = completionTime(t);
      if (ct && new Date(ct).getTime() >= ms && new Date(ct).getTime() < me) {
        done += 1;
        total += 1;
      }
    } else if (t.status !== 'cancelled') {
      const dl = effectiveDeadline(t);
      if (dl) {
        const dt = new Date(dl).getTime();
        if (dt < me) total += 1; // due this month or already overdue
      }
    }
  }
  return { done, total };
}

/* ---- activity feed ---- */

export type ActivityKind = 'created' | 'done' | 'cancelled';

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  taskId: string;
  taskTitle: string;
  /** best-available timestamp (tasks carry no cancelledAt — see buildActivityFeed) */
  at: string;
}

/**
 * Recent events derived purely from the loaded task list. `cancelled` has no
 * timestamp column, so it borrows the task's best-known time (latest doneAt,
 * else createdAt) — ordering is approximate for those rows only.
 */
export function buildActivityFeed(tasks: TaskDto[], limit = 20): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const t of tasks) {
    events.push({ id: `${t.id}-created`, kind: 'created', taskId: t.id, taskTitle: t.title, at: t.createdAt });
    if (t.status === 'done') {
      const ct = completionTime(t);
      if (ct) events.push({ id: `${t.id}-done`, kind: 'done', taskId: t.id, taskTitle: t.title, at: ct });
    } else if (t.status === 'cancelled') {
      const at = completionTime(t) ?? t.createdAt;
      events.push({ id: `${t.id}-cancelled`, kind: 'cancelled', taskId: t.id, taskTitle: t.title, at });
    }
  }
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return events.slice(0, limit);
}

/** Thai relative time — "เมื่อสักครู่" → "N นาที/ชั่วโมง/วันที่แล้ว" → date. */
export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'เมื่อสักครู่';
  if (min < 60) return `${min} นาทีที่แล้ว`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ชั่วโมงที่แล้ว`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'เมื่อวาน';
  if (day <= 30) return `${day} วันที่แล้ว`;
  const d = new Date(iso);
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear() + 543}`;
}

/* ---- personal stats ---- */

export interface PersonalStatsData {
  /** viewer's completions per week, averaged over the last 4 weeks */
  avgDonePerWeek: number;
  /** % of the viewer's completed+deadlined assignments finished on time (null = no data) */
  onTimePct: number | null;
  /** where lateness happens most: scope label → count of late/overdue slots */
  lateBuckets: { label: string; count: number }[];
  /** completions this week vs last week (Mon-start weeks) */
  thisWeek: number;
  lastWeek: number;
}

export function personalStats(tasks: TaskDto[], viewerUid: string): PersonalStatsData {
  const now = Date.now();
  const fourWeeksAgo = now - 28 * 86_400_000;
  // Monday-start of this week
  const ws = new Date();
  ws.setHours(0, 0, 0, 0);
  ws.setDate(ws.getDate() - ((ws.getDay() + 6) % 7));
  const weekStart = ws.getTime();
  const lastWeekStart = weekStart - 7 * 86_400_000;

  let recentDone = 0;
  let doneWithDeadline = 0;
  let doneOnTime = 0;
  let thisWeek = 0;
  let lastWeek = 0;
  const late = new Map<string, number>();

  for (const t of tasks) {
    const scopeLabel = t.isPersonal ? 'งานส่วนตัว' : 'งานกลุ่ม';
    for (const item of t.items) {
      for (const a of item.assignees) {
        if (a.lineUid !== viewerUid) continue;
        if (a.doneAt) {
          const dt = new Date(a.doneAt).getTime();
          if (dt >= fourWeeksAgo) recentDone += 1;
          if (dt >= weekStart) thisWeek += 1;
          else if (dt >= lastWeekStart) lastWeek += 1;
          if (item.deadline) {
            doneWithDeadline += 1;
            if (dt <= new Date(item.deadline).getTime()) doneOnTime += 1;
            else late.set(scopeLabel, (late.get(scopeLabel) ?? 0) + 1);
          }
        } else if (
          item.deadline &&
          item.status !== 'cancelled' &&
          t.status !== 'cancelled' &&
          new Date(item.deadline).getTime() < now
        ) {
          late.set(scopeLabel, (late.get(scopeLabel) ?? 0) + 1);
        }
      }
    }
  }

  return {
    avgDonePerWeek: Math.round((recentDone / 4) * 10) / 10,
    onTimePct: doneWithDeadline > 0 ? Math.round((doneOnTime / doneWithDeadline) * 100) : null,
    lateBuckets: [...late.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count),
    thisWeek,
    lastWeek,
  };
}

/* ---- calendar ---- */

export interface DayMarks {
  count: number;
  hasOverdue: boolean;
  hasDone: boolean;
}

/** Map of dayKey → dots for the calendar (keyed on each task's effective deadline). */
export function tasksByDay(tasks: TaskDto[]): Map<string, DayMarks> {
  const map = new Map<string, DayMarks>();
  for (const t of tasks) {
    if (t.status === 'cancelled') continue;
    const dl = effectiveDeadline(t);
    if (!dl) continue;
    const key = dayKey(new Date(dl));
    const cur = map.get(key) ?? { count: 0, hasOverdue: false, hasDone: false };
    cur.count += 1;
    if (t.status === 'done') cur.hasDone = true;
    else if (isOverdue(t)) cur.hasOverdue = true;
    map.set(key, cur);
  }
  return map;
}

/** Tasks whose effective deadline falls on the given local day. */
export function tasksOnDay(tasks: TaskDto[], key: string): TaskDto[] {
  return tasks.filter((t) => {
    const dl = effectiveDeadline(t);
    return dl !== null && dayKey(new Date(dl)) === key;
  });
}
