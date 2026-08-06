import type { TaskDto } from '@nookeb/shared';
import { effectiveDeadline, isOverdue } from './taskUtils';

/**
 * Floating mascots — one character image per person the viewer works with.
 *
 * The ten source images live at the repo root; the web copy is
 * `apps/web/public/characters/character_01..10.png`.
 */
export const CHARACTER_COUNT = 10;

export function characterSrc(index: number): string {
  const n = String((index % CHARACTER_COUNT) + 1).padStart(2, '0');
  return `/characters/character_${n}.png`;
}

/**
 * Assignment is random-looking but STABLE: a plain string hash over the LINE
 * uid picks the slot. A real `Math.random()` would hand the same person a new
 * face on every re-render (and every reload), which reads as a bug rather than
 * as a roster.
 */
export function characterIndexFor(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % CHARACTER_COUNT;
}

/**
 * Label for an assignee whose `display_name` snapshot is NULL.
 *
 * `task_assignees.display_name` is filled from `getChatMemberProfile` when the
 * assignment is made; it can be null when LINE could not resolve the profile.
 * A flat "สมาชิก" then renders every such person as the same row, which reads
 * as one very busy anonymous teammate instead of three unidentified ones. The
 * uid tail disambiguates them without inventing a name we do not have, and the
 * รายงานทีม row says plainly that the name is missing rather than wrong.
 */
export function unnamedLabel(lineUid: string): string {
  return `สมาชิก (${lineUid.slice(-4)})`;
}

export interface PersonStats {
  lineUid: string;
  name: string;
  /** true when the assignee row carried no display_name — see unnamedLabel */
  nameMissing: boolean;
  /** picked from the character pool, stable per lineUid */
  characterIndex: number;
  /** true when this row is the signed-in viewer */
  isMe: boolean;
  /** assignee slots across live + finished items */
  total: number;
  done: number;
  /** live slots whose task is past its deadline */
  overdue: number;
  /** live, not-yet-done slots */
  pending: number;
  /** % of this person's completed+deadlined slots finished on time (null = no data) */
  onTimePct: number | null;
  /** most recent doneAt across this person's slots (ISO, null = never) */
  lastDoneAt: string | null;
}

/**
 * Per-person rollup over the already-loaded /tasks/mine payload — no extra
 * endpoint. One row per distinct assignee LINE uid, counted in ASSIGNEE SLOTS
 * (a multi task with three items assigned to the same person is three slots),
 * which is the same unit the .xlsx export uses.
 *
 * Cancelled tasks and cancelled items are skipped entirely: they are work that
 * was called off, and counting them would drag every person's rate down for a
 * decision that was not theirs. Same rule as `overallProgress`.
 */
export function rosterStats(tasks: TaskDto[], viewerUid: string): PersonStats[] {
  const byUid = new Map<string, PersonStats & { onTimeDone: number; deadlinedDone: number }>();

  for (const task of tasks) {
    if (task.status === 'cancelled') continue;
    const taskOverdue = isOverdue(task);
    for (const item of task.items) {
      if (item.status === 'cancelled') continue;
      // Closed work — nobody owes anything on it, whatever the assignee rows say.
      const closed = task.status === 'done' || item.status === 'done';
      const itemDeadline = item.deadline ?? effectiveDeadline(task);
      for (const a of item.assignees) {
        let row = byUid.get(a.lineUid);
        if (!row) {
          row = {
            lineUid: a.lineUid,
            name: a.displayName || unnamedLabel(a.lineUid),
            nameMissing: !a.displayName,
            characterIndex: characterIndexFor(a.lineUid),
            isMe: a.lineUid === viewerUid,
            total: 0,
            done: 0,
            overdue: 0,
            pending: 0,
            onTimePct: null,
            lastDoneAt: null,
            onTimeDone: 0,
            deadlinedDone: 0,
          };
          byUid.set(a.lineUid, row);
        }
        // a later assignee row may carry a name the first one was missing
        if (a.displayName && row.nameMissing) {
          row.name = a.displayName;
          row.nameMissing = false;
        }

        row.total += 1;
        if (a.doneAt) {
          row.done += 1;
          if (!row.lastDoneAt || a.doneAt > row.lastDoneAt) row.lastDoneAt = a.doneAt;
          if (itemDeadline) {
            row.deadlinedDone += 1;
            if (new Date(a.doneAt).getTime() <= new Date(itemDeadline).getTime()) row.onTimeDone += 1;
          }
        } else if (closed) {
          // The work is finished, the assignee row just never got a `doneAt`
          // stamp — a real shape this codebase already accounts for elsewhere
          // (see `completionTime`, which returns null for exactly these tasks).
          // It counts as done, because it IS done. Counting it as pending put
          // the slot in ค้าง, and the raw `itemDeadline < now` test below then
          // ALSO put it in เลยกำหนด — so a closed task showed up as someone's
          // overdue work forever. It stays out of the ตรงเวลา ratio, though:
          // with no completion time there is nothing to compare to the deadline,
          // and guessing would be inventing evidence.
          row.done += 1;
        } else {
          row.pending += 1;
          if (taskOverdue || (itemDeadline && new Date(itemDeadline).getTime() < Date.now())) {
            row.overdue += 1;
          }
        }
      }
    }
  }

  return [...byUid.values()]
    .map(({ onTimeDone, deadlinedDone, ...row }) => ({
      ...row,
      onTimePct: deadlinedDone > 0 ? Math.round((onTimeDone / deadlinedDone) * 100) : null,
    }))
    .sort((a, b) => {
      if (a.isMe !== b.isMe) return a.isMe ? -1 : 1; // the viewer leads their own report
      if (b.total !== a.total) return b.total - a.total;
      return a.name.localeCompare(b.name, 'th');
    });
}

/* ---- floating-layer placement, persisted per person ---- */

const POS_KEY = 'nookeb.tasks.mascotPos';
const HIDE_KEY = 'nookeb.tasks.mascotHidden';

/** Viewport-relative position, 0–1 on both axes so a resize keeps them on screen. */
export interface MascotPos {
  x: number;
  y: number;
}

export function loadMascotPositions(): Record<string, MascotPos> {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, MascotPos> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const p = v as { x?: unknown; y?: unknown };
      if (typeof p?.x === 'number' && typeof p?.y === 'number') {
        out[k] = { x: p.x, y: p.y };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function saveMascotPositions(pos: Record<string, MascotPos>): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    /* storage unavailable — positions simply reset next visit */
  }
}

export function loadMascotsHidden(): boolean {
  try {
    return localStorage.getItem(HIDE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveMascotsHidden(hidden: boolean): void {
  try {
    localStorage.setItem(HIDE_KEY, hidden ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/**
 * Default resting spots for mascots that have never been dragged.
 *
 * They alternate between the LEFT and RIGHT gutters rather than stacking into
 * a second right-hand column: the content column is centred and capped, so a
 * second column has nowhere to go but on top of the page. Six sprites become
 * three rows a side, which fits every desktop width the layer is enabled at.
 */
export function defaultPos(index: number): MascotPos {
  const onRight = index % 2 === 0;
  const row = Math.floor(index / 2);
  return {
    x: onRight ? 0.94 : 0.06,
    y: 0.2 + row * 0.24,
  };
}
