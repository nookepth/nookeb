/**
 * §4b reminder picker — the pure half: when a shot fires, how to say it, and
 * which plan would unlock one more.
 *
 * Split out of ReminderPicker.tsx when the picker grew a bottom sheet: the
 * FIELD renders a summary and the SHEET renders a per-row preview, and both
 * need the same date maths. Keeping it in the component meant the sheet either
 * imported from a component file or grew a second copy of `fireAt` that could
 * disagree with the first about what the user was promised.
 *
 * Pure and DOM-free on purpose (project rule 14's spirit): no React, no
 * browser API beyond `Date`, so it can be reasoned about — and later tested —
 * without a renderer.
 */

import {
  MAX_REMINDER_INTERVALS,
  REMINDER_MAX_SELECTABLE,
  REMINDER_OPTION_BY_MINUTES,
  REMINDER_INTERVAL_OPTIONS,
  type ReminderIntervalOption,
} from './taskDraft';

export const PLAN_LABEL: Record<string, string> = {
  free: 'ฟรี',
  pro: 'Pro',
  premium: 'Premium',
  team: 'Premium',
};

/** The cheapest plan that allows `want` ticks, for the upgrade nudge. */
export function planThatAllows(want: number): 'pro' | 'premium' | null {
  if (want <= REMINDER_MAX_SELECTABLE.pro) return 'pro';
  if (want <= REMINDER_MAX_SELECTABLE.premium) return 'premium';
  return null;
}

/**
 * The Thai upgrade copy shown when a locked row is tapped. Unchanged wording
 * from the chip-grid build — it is the sentence users have already seen, and
 * the API answers with the same shape (REMINDER_INTERVAL_LIMIT).
 */
export function lockHintFor(args: {
  plan?: string | null;
  maxSelectable: number;
  selectedCount: number;
}): string {
  const planLabel = args.plan ? (PLAN_LABEL[args.plan] ?? args.plan) : null;
  const upgrade = planThatAllows(args.selectedCount + 1);
  return upgrade
    ? `แพ็กเกจ${planLabel ?? 'ปัจจุบัน'}เลือกได้ ${args.maxSelectable} ช่วง — อัปเกรดเป็น ${
        PLAN_LABEL[upgrade]
      } เลือกได้ ${REMINDER_MAX_SELECTABLE[upgrade]} ช่วงน้า`
    : `เลือกได้สูงสุด ${MAX_REMINDER_INTERVALS} ช่วงน้า`;
}

/**
 * When one shot will actually fire. `deadline` is whatever the form holds — a
 * datetime-local value ("2026-08-05T18:00") or an ISO instant; `new Date` reads
 * both, and a datetime-local is read in the device's own wall clock, which is
 * the clock the user typed it in.
 *
 * `leadMinutes` is minutes BEFORE the deadline, so a negative lead (the -60
 * overdue chase) lands after it — one subtraction covers both, with no branch.
 */
export function fireAt(deadline: string, leadMinutes: number): Date {
  return new Date(new Date(deadline).getTime() - leadMinutes * 60_000);
}

const THAI_MONTHS_SHORT = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
];

/** "5 ส.ค. 18:00" — short enough to sit on one phone line next to a row label. */
export function formatWhen(at: Date): string {
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `${at.getDate()} ${THAI_MONTHS_SHORT[at.getMonth()]} ${hh}:${mm}`;
}

export interface ReminderShotPreview {
  opt: ReminderIntervalOption;
  /** null when there is no usable deadline to anchor against (e.g. งานประจำ) */
  when: Date | null;
  /** true when this shot's moment has already passed — the scheduler skips it */
  past: boolean;
}

/**
 * The preview rows, furthest-out reminder first — the order they will actually
 * arrive in. A shot whose time has already passed is FLAGGED rather than
 * hidden, because the scheduler silently skips it (see scheduleReminders:
 * "already past — skip") and a user who ticked "3 วัน" for a deadline two days
 * out must not be left believing a reminder is coming.
 *
 * Sorting descending by lead puts -60 last, which is where the overdue chase
 * belongs: it is the only shot that fires after the deadline.
 */
export function buildPreview(
  value: readonly number[],
  deadline?: string | null,
): ReminderShotPreview[] {
  const chosen = REMINDER_INTERVAL_OPTIONS.filter((o) => value.includes(o.minutes)).sort(
    (a, b) => b.minutes - a.minutes,
  );
  const deadlineMs = deadline ? new Date(deadline).getTime() : NaN;
  if (!Number.isFinite(deadlineMs)) {
    return chosen.map((opt) => ({ opt, when: null, past: false }));
  }
  const now = Date.now();
  return chosen.map((opt) => {
    const at = fireAt(deadline!, opt.minutes);
    return { opt, when: at, past: at.getTime() <= now };
  });
}

/**
 * The one-line summary on the collapsed field, e.g. "3 ช่วง · 1 ว., 3 ชม., เลย 1 ชม.".
 *
 * The COUNT leads because it is the thing a plan caps and the thing a user
 * checks at a glance; the short labels follow so the field still answers "which
 * ones" without opening the sheet. Ordered like the preview (furthest-out
 * first) so the field and the sheet never disagree about sequence.
 */
export function summarize(value: readonly number[]): string {
  const shorts = [...value]
    .sort((a, b) => b - a)
    .map((m) => REMINDER_OPTION_BY_MINUTES.get(m)?.short)
    .filter((s): s is string => Boolean(s));
  if (shorts.length === 0) return '';
  return `${shorts.length} ช่วง · ${shorts.join(', ')}`;
}
