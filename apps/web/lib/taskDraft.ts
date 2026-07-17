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

export interface TaskDraft {
  groupId: string | null;
  type: 'single' | 'multi' | 'recurring';
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

export function emptyDraft(type: TaskDraft['type']): TaskDraft {
  return {
    groupId: null,
    type,
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
    return raw ? (JSON.parse(raw) as TaskDraft) : null;
  } catch {
    return null;
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
