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

/**
 * §4b — the reminder lead times a creator may tick, in MINUTES before the
 * deadline. MIRRORS `REMINDER_INTERVAL_CHOICES` in apps/api/src/config/plans.ts,
 * which is the source of truth and the only enforcer: a hand-rolled request with
 * an off-menu value is rejected there with `INVALID_REMINDER_INTERVAL`.
 *
 * MINUTES, NOT HOURS, SINCE MIGRATION 055. The five original lead times are all
 * still here as their minute equivalents, so nobody's saved selection changed
 * meaning; see `normalizeLeadMinutes` in packages/shared for how a draft or a
 * task row written before the change is read.
 *
 * EVERY PLAN SEES ALL FIFTEEN. A plan caps how MANY may be ticked, never which
 * — so this list is never filtered per plan (see REMINDER_MAX_SELECTABLE).
 *
 * ORDERED FURTHEST-OUT → LATEST, which is the order the reminders arrive in.
 * `group` is the sheet's section heading; the groups exist because a flat list
 * of fifteen is a wall, and "how far out am I thinking" is the first decision
 * a user makes.
 *
 * `ontime` (migration 056, minutes = 0) is its OWN group rather than a row at
 * the bottom of `minute`: "ใกล้ถึงกำหนด" promises a warning BEFORE the deadline,
 * and a ping that lands exactly on it is a different kind of thing. Its own
 * heading also keeps the four sections each meaning one clear thing, and keeps
 * the whole sheet strictly descending by lead time (day → hour → minute →
 * on time → after), which is the order the reminders actually arrive in.
 */
export type ReminderGroup = 'day' | 'hour' | 'minute' | 'ontime' | 'after';

export interface ReminderIntervalOption {
  /** minutes before the deadline (negative = after) — the value stored in
   *  tasks.reminder_intervals */
  minutes: number;
  /** row label in the sheet, e.g. "1 วัน" */
  label: string;
  /** compact form for the field's summary line, e.g. "1 ว." */
  short: string;
  /** spoken form for the preview/aria line, e.g. "1 วันก่อนกำหนด" */
  spoken: string;
  group: ReminderGroup;
}

export const REMINDER_GROUP_LABEL: Record<ReminderGroup, string> = {
  day: 'ล่วงหน้าเป็นวัน',
  hour: 'ล่วงหน้าเป็นชั่วโมง',
  minute: 'ใกล้ถึงกำหนด',
  ontime: 'ตรงเวลากำหนด',
  after: 'หลังเลยกำหนด',
};

export const REMINDER_GROUP_ORDER: ReminderGroup[] = [
  'day',
  'hour',
  'minute',
  'ontime',
  'after',
];

export const REMINDER_INTERVAL_OPTIONS: ReminderIntervalOption[] = [
  { minutes: 10080, label: '1 สัปดาห์', short: '1 สัปดาห์', spoken: '1 สัปดาห์ก่อนกำหนด', group: 'day' },
  { minutes: 7200, label: '5 วัน', short: '5 ว.', spoken: '5 วันก่อนกำหนด', group: 'day' },
  { minutes: 4320, label: '3 วัน', short: '3 ว.', spoken: '3 วันก่อนกำหนด', group: 'day' },
  { minutes: 2880, label: '2 วัน', short: '2 ว.', spoken: '2 วันก่อนกำหนด', group: 'day' },
  { minutes: 1440, label: '1 วัน', short: '1 ว.', spoken: '1 วันก่อนกำหนด', group: 'day' },
  { minutes: 720, label: '12 ชั่วโมง', short: '12 ชม.', spoken: '12 ชั่วโมงก่อนกำหนด', group: 'hour' },
  { minutes: 360, label: '6 ชั่วโมง', short: '6 ชม.', spoken: '6 ชั่วโมงก่อนกำหนด', group: 'hour' },
  { minutes: 180, label: '3 ชั่วโมง', short: '3 ชม.', spoken: '3 ชั่วโมงก่อนกำหนด', group: 'hour' },
  { minutes: 120, label: '2 ชั่วโมง', short: '2 ชม.', spoken: '2 ชั่วโมงก่อนกำหนด', group: 'hour' },
  { minutes: 60, label: '1 ชั่วโมง', short: '1 ชม.', spoken: '1 ชั่วโมงก่อนกำหนด', group: 'hour' },
  { minutes: 30, label: '30 นาที', short: '30 น.', spoken: '30 นาทีก่อนกำหนด', group: 'minute' },
  { minutes: 15, label: '15 นาที', short: '15 น.', spoken: '15 นาทีก่อนกำหนด', group: 'minute' },
  { minutes: 5, label: '5 นาที', short: '5 น.', spoken: '5 นาทีก่อนกำหนด', group: 'minute' },
  {
    // Migration 056. Labelled by WHEN IT LANDS, not by its lead time: "0 นาที"
    // is arithmetic, "ถึงกำหนดพอดี" is the thing the user wants. Same idea as
    // iOS Calendar's "เวลาที่กิจกรรมเกิดขึ้น", said in หนูเก็บ's own voice.
    minutes: 0,
    label: 'ถึงกำหนดพอดี',
    short: 'ตรงเวลา',
    spoken: 'ตอนถึงกำหนดพอดี',
    group: 'ontime',
  },
  {
    minutes: -60,
    label: 'เลยกำหนด 1 ชั่วโมง',
    short: 'เลย 1 ชม.',
    spoken: 'หลังเลยกำหนด 1 ชั่วโมง',
    group: 'after',
  },
];

export const REMINDER_OPTION_BY_MINUTES = new Map(
  REMINDER_INTERVAL_OPTIONS.map((o) => [o.minutes, o]),
);

/**
 * Pre-055 hour values, for drafts composed before the unit change. Mirrors
 * LEGACY_REMINDER_INTERVAL_HOURS / normalizeLeadMinutes in packages/shared —
 * the web cannot import the API's build, and the two sets are disjoint from the
 * minute choices, which is what makes the conversion unambiguous.
 */
const LEGACY_INTERVAL_HOURS = [3, 6, 24, 48, 72];

export function normalizeLeadMinutes(stored: number): number {
  return LEGACY_INTERVAL_HOURS.includes(stored) ? stored * 60 : stored;
}

/**
 * How many options each plan may tick. MIRRORS `REMINDER_POLICY[plan].maxSelectable`
 * in apps/api/src/config/plans.ts — same mirroring contract the old
 * MAX_REMINDER_COUNT had, and for the same reason: the two apps share no runtime,
 * and the API re-validates every selection (403 `REMINDER_INTERVAL_LIMIT`), so
 * this copy can only ever cost a user a nicer message, never an entitlement.
 */
export const REMINDER_MAX_SELECTABLE: Record<'free' | 'pro' | 'premium', number> = {
  free: 1,
  pro: 2,
  premium: 4,
};

/** Hard ceiling across every plan — the fallback when the viewer's plan is unknown. */
export const MAX_REMINDER_INTERVALS = REMINDER_MAX_SELECTABLE.premium;

/**
 * Plan → how many selections, tolerating anything unknown.
 *
 * An unknown/missing plan resolves to the CEILING, not to free: the picker is a
 * convenience and the API is the gate, so letting a premium user whose profile
 * fetch failed tick four beats silently downgrading them to one. Legacy 'team'
 * rows are premium (normalizePlan in config/plans.ts).
 */
export function maxRemindersForPlan(plan: string | null | undefined): number {
  if (plan === 'free') return REMINDER_MAX_SELECTABLE.free;
  if (plan === 'pro') return REMINDER_MAX_SELECTABLE.pro;
  if (plan === 'premium' || plan === 'team') return REMINDER_MAX_SELECTABLE.premium;
  return MAX_REMINDER_INTERVALS;
}

/**
 * Legacy "จำนวนการแจ้งเตือน (ครั้ง)" → intervals, for drafts written by the old
 * stepper UI. Mirrors REMINDER_COUNT_PRIORITY_MINUTES in config/plans.ts (most
 * useful lead time first) so a draft mid-flight when the build shipped keeps the
 * reminders it was showing rather than silently losing them.
 */
const LEGACY_COUNT_PRIORITY_MINUTES = [1440, 180, 4320, 2880];

export function intervalsFromLegacyCount(count: number | null | undefined): number[] {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return [];
  return LEGACY_COUNT_PRIORITY_MINUTES.slice(
    0,
    Math.min(count, LEGACY_COUNT_PRIORITY_MINUTES.length),
  );
}

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
  /**
   * §4b — the ticked reminder lead times, in MINUTES before the deadline (e.g.
   * [1440, 180]; -60 = one hour after). Values come from
   * REMINDER_INTERVAL_OPTIONS only.
   *
   * EMPTY = no reminders, and it is the DEFAULT: a reminder is a LINE push, and
   * a task must not start chasing people because a form field happened to be
   * pre-filled. How many may actually be ticked is enforced server-side
   * (free 1 / pro 2 / premium 4) — this is the request, not the entitlement.
   */
  reminderIntervals: number[];
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
    reminderIntervals: [],
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
    const draft = JSON.parse(raw) as TaskDraft & { reminderCount?: number };
    // A draft written before scope/urgency/reminders existed: group draft,
    // ปกติ urgency, no reminders (empty — never invent chases the creator never
    // asked for, same rule as the server's "selected nothing schedules nothing").
    //
    // `reminderCount` is the old stepper's field. A draft still carrying it was
    // composed in a tab opened before this build shipped, so it is translated
    // rather than dropped — the user saw those reminders on screen.
    return {
      ...draft,
      scope: draft.scope ?? 'group',
      urgency: draft.urgency ?? 'normal',
      // normalizeLeadMinutes converts a draft composed before the hours→minutes
      // change (migration 055) instead of dropping it — same reasoning as
      // reminderCount below, one unit change later.
      reminderIntervals: Array.isArray(draft.reminderIntervals)
        ? draft.reminderIntervals
            .filter((v) => typeof v === 'number')
            .map(normalizeLeadMinutes)
        : intervalsFromLegacyCount(draft.reminderCount),
    };
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
