/**
 * Create-flow draft for ระบบตามงาน, persisted in sessionStorage. Chosen over
 * URL params (a multi task's items overflow a URL) and React context (LIFF
 * navigation can hard-reload the page, wiping in-memory state): sessionStorage
 * survives the reload but still scopes the draft to this LIFF tab, and clears
 * itself when the tab closes.
 */

export interface DraftMember {
  lineUid: string;
  displayName: string | null;
  pictureUrl: string | null;
}

export interface DraftItem {
  title: string;
  description: string | null;
  /** datetime-local value ("2026-07-20T14:30") or null = ใช้ global deadline */
  deadline: string | null;
  assignees: DraftMember[];
}

export interface RecurrenceDraft {
  freq: 'daily' | 'weekly' | 'monthly';
  day: number;
  weekday: number;
  time: string;
}

export type TaskScope = 'group' | 'personal';

/** ความเร่งด่วน (canonical keys, migration 048) — labels live in the UI. */
export type TaskUrgency = 'urgent_max' | 'urgent' | 'normal' | 'relaxed';

/** Selector options, least→most urgent (reads left-to-right as escalation).
 * Plain-text labels — the LIFF UI is a no-emoji surface; the coloured dot is
 * drawn in CSS by the selector itself. */
export const URGENCY_OPTIONS: { value: TaskUrgency; label: string; color: string }[] = [
  { value: 'relaxed', label: 'ไม่รีบ', color: '#2E7D32' },
  { value: 'normal', label: 'ปกติ', color: '#B45309' },
  { value: 'urgent', label: 'ด่วน', color: '#F57C00' },
  { value: 'urgent_max', label: 'ด่วนมาก', color: '#C62828' },
];

export interface TaskDraft {
  /**
   * 'personal' = งานส่วนตัว created from a 1-on-1 DM (migration 043): groupId
   * stays null, the member step is skipped, and the owner/assignee is resolved
   * server-side from the session — the client never carries an identity.
   */
  scope: TaskScope;
  groupId: string | null;
  type: 'single' | 'multi' | 'recurring';
  /** ความเร่งด่วน — always present in new drafts; old drafts default ปกติ. */
  urgency: TaskUrgency;
  title: string;
  /** datetime-local value */
  globalDeadline: string | null;
  description: string;
  recurrence: RecurrenceDraft;
  /** current member selection (single/recurring assignees; multi = the item
   * being composed — appended into items when the member step confirms) */
  selected: DraftMember[];
  /** multi only: items already composed */
  items: DraftItem[];
  /** multi only: the bottom-sheet item awaiting its member selection */
  pendingItem: { title: string; deadline: string | null } | null;
}

const KEY = 'nookeb_task_draft';

export function emptyDraft(type: TaskDraft['type'], scope: TaskScope = 'group'): TaskDraft {
  return {
    scope,
    groupId: null,
    type,
    urgency: 'normal',
    title: '',
    globalDeadline: null,
    description: '',
    recurrence: { freq: 'monthly', day: 5, weekday: 1, time: '09:00' },
    selected: [],
    items: [],
    pendingItem: null,
  };
}

export function loadDraft(): TaskDraft | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as TaskDraft;
    // A draft written before scope/urgency existed: group draft, ปกติ urgency.
    return { ...draft, scope: draft.scope ?? 'group', urgency: draft.urgency ?? 'normal' };
  } catch {
    return null;
  }
}

/**
 * ?scope=personal on the current URL — the personal counterpart of
 * resolveGroupId(). The DM card carries no id, so this query IS the whole
 * signal; the API still derives the owner from the session, so a forged
 * ?scope=personal can only ever create the caller's OWN task.
 */
export function resolveScope(): TaskScope {
  if (typeof window === 'undefined') return 'group';
  try {
    return new URLSearchParams(window.location.search).get('scope') === 'personal'
      ? 'personal'
      : 'group';
  } catch {
    return 'group';
  }
}

export function saveDraft(draft: TaskDraft): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    // storage full/blocked — the flow still works within this page's state
  }
}

export function clearDraft(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** datetime-local → ISO instant (device clock is the user's wall clock). */
export function localToIso(value: string): string {
  return new Date(value).toISOString();
}
