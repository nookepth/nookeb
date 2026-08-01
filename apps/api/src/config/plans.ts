/**
 * ระบบสมาชิก — SINGLE SOURCE OF TRUTH for every plan limit, price and gate.
 *
 * Nothing else in the codebase may hard-code a plan number. If you find a bare
 * `10` or `30` guarding a feature, it belongs here.
 *
 * PURE AND ENV-FREE by design (project rule 14): this module imports nothing,
 * reads no environment, and touches no I/O, so the unit tests can import it
 * without an .env and so it can be shared with the worker process verbatim.
 *
 * Conventions
 *  - `UNLIMITED` (-1) is the only sentinel. Never use 0, Infinity or null for
 *    "no cap": 0 is a real limit (free plan boosts) and Infinity does not
 *    survive JSON or a Postgres INTEGER column.
 *  - Monthly quotas reset on the 1st at 00:00 ICT — see ./billing-period.ts.
 *  - Capacity limits (vault, boosts, locker bytes) do NOT reset; they are a
 *    ceiling on live rows.
 */

// ---------------------------------------------------------------------------
// Plan vocabulary
// ---------------------------------------------------------------------------

export const PLANS = ['free', 'pro', 'premium'] as const;
export type Plan = (typeof PLANS)[number];

/**
 * Legacy 'team' rows (migration 001's original vocabulary) are treated as
 * premium — it was the top tier when it was written, and the 051 CHECK still
 * accepts it so no backfill is required. Anything unrecognised falls back to
 * the LEAST privileged plan: an unknown value must never unlock a paid feature.
 */
export function normalizePlan(raw: string | null | undefined): Plan {
  switch (raw) {
    case 'pro':
      return 'pro';
    case 'premium':
    case 'team':
      return 'premium';
    default:
      return 'free';
  }
}

export const UNLIMITED = -1;
export function isUnlimited(limit: number): boolean {
  return limit < 0;
}

const GB = 1024 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Pricing (THB, whole Baht — every listed price is an integer)
// ---------------------------------------------------------------------------

export type BillingCycle = 'monthly' | 'yearly';

export interface PlanPricing {
  /** ฿ per month when billed monthly. */
  monthly: number;
  /** ฿ per year when billed yearly. null = not offered (free plan). */
  yearly: number | null;
}

export const PLAN_PRICING: Record<Plan, PlanPricing> = {
  free: { monthly: 0, yearly: null },
  // Yearly is priced at 10× monthly — the usual "two months free" shape.
  pro: { monthly: 79, yearly: 790 },
  premium: { monthly: 149, yearly: 1490 },
};

/**
 * ชื่อแพ็กเกจที่แสดงกับผู้ใช้ — the ONLY place these names are written.
 *
 * NO EMOJI, ever (brand rule, CLAUDE.md §3 rule 13). The web mirrors this map
 * in apps/web/lib/quota-errors.ts because the two apps do not share a runtime;
 * if you change a name here, change it there.
 */
export const PLAN_DISPLAY_NAME: Record<Plan, string> = {
  free: 'หนูเก็บวัยเด็ก',
  pro: 'หนูเก็บโตแย้ว',
  premium: 'หนูเก็บแปลงร่าง',
};

export function planDisplayName(plan: Plan): string {
  return PLAN_DISPLAY_NAME[plan];
}

/** Price in THB for a plan + cycle, or null when that combination isn't sold. */
export function priceOf(plan: Plan, cycle: BillingCycle): number | null {
  const p = PLAN_PRICING[plan];
  return cycle === 'monthly' ? p.monthly : p.yearly;
}

// ---------------------------------------------------------------------------
// Monthly quotas — reset on the 1st, 00:00 ICT
// ---------------------------------------------------------------------------

/**
 * Every per-month counter. The key is what lands in `user_quotas.feature`, so
 * renaming one is a data migration — treat these strings as schema.
 */
export const MONTHLY_FEATURES = [
  'group_files',
  'tasks',
  'task_notifications',
  'word_conversion_pages',
  'scans',
  'pdf_merges',
  'gift_boxes',
  'diary_reminders',
] as const;
export type MonthlyFeature = (typeof MONTHLY_FEATURES)[number];

export const MONTHLY_QUOTAS: Record<MonthlyFeature, Record<Plan, number>> = {
  // §2 — scoped to (user, group, month), counted when a file enters a group's
  // คลังไฟล์, NOT on message send. Uses the UPLOADER's plan.
  group_files: { free: 50, pro: 500, premium: 1500 },
  // §5 — counted at creation. Deleting a task does NOT refund.
  tasks: { free: 7, pro: 25, premium: 100 },
  // §4a — counted per reminder actually pushed.
  task_notifications: { free: 7, pro: 30, premium: 100 },
  // §7 — counted in PAGES of the source document, not documents.
  word_conversion_pages: { free: 10, pro: 30, premium: 100 },
  // §8 — one unit per finalised scan session (colour or B&W alike).
  scans: { free: 10, pro: 30, premium: 100 },
  // §9 — one unit per finalised merge, regardless of source count.
  pdf_merges: { free: 10, pro: 30, premium: 100 },
  // §11
  gift_boxes: { free: 3, pro: 10, premium: 30 },
  // §17 — free gets 5 pushes a month; paid plans get a daily push (uncapped).
  diary_reminders: { free: 5, pro: UNLIMITED, premium: UNLIMITED },
};

// ---------------------------------------------------------------------------
// Capacity limits — a ceiling on live rows, never reset
// ---------------------------------------------------------------------------

export const CAPACITY_FEATURES = ['vault_files', 'group_boosts'] as const;
export type CapacityFeature = (typeof CAPACITY_FEATURES)[number];

export const CAPACITY_LIMITS: Record<CapacityFeature, Record<Plan, number>> = {
  // §10 — hard cap on TOTAL live vault items. Not a monthly quota: deleting a
  // vault file frees a slot immediately.
  vault_files: { free: 10, pro: 30, premium: 100 },
  // §3 — how many groups may be boosted AT ONCE.
  group_boosts: { free: 0, pro: 1, premium: 3 },
};

/** §3c — a boost lasts this long from activation. */
export const BOOST_DURATION_DAYS = 30;

export type QuotaFeature = MonthlyFeature | CapacityFeature;

// ---------------------------------------------------------------------------
// Locker storage (§1)
// ---------------------------------------------------------------------------

export const LOCKER_LIMITS = {
  free: {
    baseBytes: 1 * GB,
    /** referral bonus per successful referral */
    perReferralBytes: 1 * GB,
    /** ceiling INCLUDING referral bonuses */
    maxBytes: 4 * GB,
  },
  pro: { flatBytes: 15 * GB },
  premium: { flatBytes: 60 * GB },
} as const;

/**
 * The authoritative locker capacity for a user, in bytes.
 *
 * Referral bonuses apply to FREE ONLY — a paid plan's flat allowance already
 * exceeds the free ceiling, and stacking them would let 4 GB of referrals ride
 * on top of 60 GB for free. `referralCount` is ignored for pro/premium by
 * design, not by omission.
 *
 * This value is mirrored into `users.storage_limit` (see
 * services/membership.service.ts) so the existing atomic
 * `increment_personal_storage` RPC keeps enforcing it without changes.
 */
export function lockerLimitBytes(plan: Plan, referralCount = 0): number {
  if (plan === 'pro') return LOCKER_LIMITS.pro.flatBytes;
  if (plan === 'premium') return LOCKER_LIMITS.premium.flatBytes;
  const earned = Math.max(0, Math.floor(referralCount)) * LOCKER_LIMITS.free.perReferralBytes;
  return Math.min(LOCKER_LIMITS.free.baseBytes + earned, LOCKER_LIMITS.free.maxBytes);
}

// ---------------------------------------------------------------------------
// Task reminder configuration (§4b)
// ---------------------------------------------------------------------------

/**
 * §4b — the ONLY selectable intervals, in MINUTES before the deadline. This is
 * a closed set rendered as a checklist; free text is never accepted. Mirrored
 * by the `tasks_reminder_intervals_check` constraint in migration 056 and by
 * REMIND_SHOTS in packages/shared (plans.test.ts asserts all three agree).
 *
 * EVERY PLAN SEES THE SAME FIFTEEN OPTIONS. Plans differ only in how many may
 * be ticked — there is no per-plan menu and no plan-specific shot.
 *
 * UNIT CHANGED IN MIGRATION 055 (was hours: [3, 6, 24, 48, 72]). Minutes is now
 * the unit because 15- and 30-minute lead times are not expressible in integer
 * hours. The five original lead times all survive as their minute equivalents,
 * so no user's saved selection changed meaning.
 *
 * THE FLOOR WAS 15 MINUTES UNTIL 056, WHICH ADDED 5 AND 0. The original
 * reasoning against them stands as a UX caveat and was never a functional
 * blocker: reminders are scheduled at CREATE time and a shot already in the past
 * is silently skipped (see scheduleReminders), so a 5-minute or at-deadline
 * choice made on a task due in ten minutes fires once and a task due in two
 * minutes fires not at all. That is visible BEFORE committing — the picker
 * computes each row's real fire time and strikes past rows through with
 * "เลยเวลาแล้ว หนูจะข้ามรอบนี้" — so the failure mode is legible rather than
 * silent, and the choice is the creator's to make.
 *
 * `0` IS A LEAD TIME, NOT A SENTINEL. It means "fire at the deadline". The only
 * "no reminders" state is an EMPTY selection; `intervalsForCount(0)` returns
 * `[]` for that reason and does not produce the 0 interval. Never write a
 * truthiness test against an interval value.
 *
 * WHY THE CEILING IS ONE WEEK, NOT 30 DAYS. A ping a month out arrives before
 * the work is actionable, and with a 4-tick ceiling every long-tail slot
 * displaces a useful one. One week is the "เริ่มทำได้แล้ว" nudge.
 *
 * `-60` IS THE ONE NEGATIVE VALUE: 60 minutes AFTER the deadline (the overdue
 * chase). Sorted last by the descending normaliser in validateReminderSelection,
 * which is also the order it fires in — nothing special-cases it.
 */
export const REMINDER_INTERVAL_CHOICES = [
  10080, // 1 สัปดาห์
  7200, //  5 วัน
  4320, //  3 วัน
  2880, //  2 วัน
  1440, //  1 วัน
  720, //  12 ชั่วโมง
  360, //   6 ชั่วโมง
  180, //   3 ชั่วโมง
  120, //   2 ชั่วโมง
  60, //    1 ชั่วโมง
  30, //   30 นาที
  15, //   15 นาที
  5, //     5 นาที           (056)
  0, //    ถึงกำหนดพอดี      (056 — a real lead time, see the header)
  -60, //  เลยกำหนด 1 ชั่วโมง
] as const;
export type ReminderInterval = (typeof REMINDER_INTERVAL_CHOICES)[number];

export interface ReminderPolicy {
  /**
   * §4b — how many of the fifteen options the plan may tick.
   *
   * This is the ONLY thing a plan changes about reminders. There is deliberately
   * no deadline-only fallback and no plan-specific default schedule: a task's
   * reminders are exactly what the creator selected, on every tier. Selecting
   * nothing schedules nothing.
   */
  maxSelectable: number;
  /** §4c — "เตือนเฉพาะคนที่ยังไม่ส่งงาน". */
  notifyOnlyPending: boolean;
}

export const REMINDER_POLICY: Record<Plan, ReminderPolicy> = {
  free: { maxSelectable: 1, notifyOnlyPending: false },
  pro: { maxSelectable: 2, notifyOnlyPending: true },
  premium: { maxSelectable: 4, notifyOnlyPending: true },
};

export function isReminderInterval(n: number): n is ReminderInterval {
  return (REMINDER_INTERVAL_CHOICES as readonly number[]).includes(n);
}

/**
 * "จำนวนการแจ้งเตือน (ครั้ง)" → which intervals that many reminders means.
 *
 * The create forms ask for a COUNT, not five checkboxes: on a phone (LIFF) a
 * number is one tap and a checkbox grid is five, and the count is also what the
 * chat command has always accepted ("เตือน 2 ครั้ง"). The server expands the
 * count here so both doors end up writing the same `tasks.reminder_intervals`
 * and go through the same plan gate — a count is sugar over the selection, not
 * a second reminder model.
 *
 * ORDER IS THE POINT: most-useful-first, so `n = 1` gives the day-before nudge
 * rather than an arbitrary one. It mirrors REMIND_PRIORITY in task-command.ts
 * with one deliberate difference — `overdue` (+1h AFTER the deadline) is not
 * here, because that is a chase, not a lead time, and it is not expressible as
 * an interval. Chat-created tasks keep reaching it through `reminder_count`.
 *
 * THE CEILING IS 4, NOT 15. A count is only meaningful if a distinct lead time
 * exists for it, and four well-spaced ones cover what a chat command can
 * usefully mean; the fifteen-option list is a picker affordance, not something
 * "เตือน 9 ครั้ง" should be able to reach. The plan cap
 * (REMINDER_POLICY.maxSelectable — free 1 / pro 2 / premium 4) then applies on
 * top, so nobody can request more shots than they pay for.
 *
 * MINUTES since migration 055, like every other interval value.
 */
export const REMINDER_COUNT_PRIORITY_MINUTES = [1440, 180, 4320, 2880] as const;

/** Hard ceiling on the count field, independent of plan. */
export const MAX_REMINDER_COUNT = REMINDER_COUNT_PRIORITY_MINUTES.length;

/**
 * Expand a count into intervals. 0 / null → `[]`, which schedules NOTHING —
 * the same "selected nothing" state as an empty checkbox set, deliberately not
 * a default schedule.
 *
 * Does NOT apply the plan cap: it returns what was asked for, and
 * `resolveReminderConfig` rejects an over-cap request with the upgrade copy.
 * Silently trimming here would ship a task with fewer reminders than the form
 * showed and tell the creator nothing.
 */
export function intervalsForCount(count: number | null | undefined): number[] {
  if (count == null || !Number.isFinite(count)) return [];
  const n = Math.max(0, Math.min(MAX_REMINDER_COUNT, Math.floor(count)));
  return REMINDER_COUNT_PRIORITY_MINUTES.slice(0, n);
}

/**
 * Validate a checkbox selection against the plan. Pure — the server-side half
 * of "validation: enforce checkbox limit server-side (not just client-side)".
 *
 * Returns the normalised (deduped, sorted descending = furthest-out reminder
 * first) selection, or a typed error code.
 */
export type ReminderSelectionResult =
  | { ok: true; intervals: number[] }
  | { ok: false; code: 'INVALID_INTERVAL' | 'TOO_MANY_INTERVALS'; max: number };

export function validateReminderSelection(
  plan: Plan,
  raw: readonly number[] | null | undefined,
): ReminderSelectionResult {
  const policy = REMINDER_POLICY[plan];
  if (!raw || raw.length === 0) return { ok: true, intervals: [] };

  for (const n of raw) {
    if (!Number.isInteger(n) || !isReminderInterval(n)) {
      return { ok: false, code: 'INVALID_INTERVAL', max: policy.maxSelectable };
    }
  }
  // Dedupe BEFORE counting: ticking the same box twice is a client bug, not an
  // attempt to buy a second slot, so it must not push a valid selection over.
  const unique = [...new Set(raw)].sort((a, b) => b - a);
  if (unique.length > policy.maxSelectable) {
    return { ok: false, code: 'TOO_MANY_INTERVALS', max: policy.maxSelectable };
  }
  return { ok: true, intervals: unique };
}

// ---------------------------------------------------------------------------
// Boolean feature gates
// ---------------------------------------------------------------------------

export const PLAN_FEATURES = [
  /** §14 — .xlsx export of the task summary */
  'export_task_summary',
  /** §15 — Google Sheets mirror */
  'google_sheets',
  /** §16 — รายงานผลการทำงานรายบุคคล */
  'performance_report',
  /** §4c — reminder targeting */
  'notify_only_pending',
  /** §3 — may boost any group at all */
  'group_boost',
  /** §18 — premium onboarding setup call */
  'onboarding_call',
  /** §1 — referral bonus applies to the locker allowance */
  'referral_storage_bonus',
  /** §17 — a diary push every day rather than a monthly allowance */
  'daily_diary_reminder',
] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

export const FEATURE_ACCESS: Record<PlanFeature, Record<Plan, boolean>> = {
  export_task_summary: { free: false, pro: true, premium: true },
  google_sheets: { free: false, pro: false, premium: true },
  performance_report: { free: false, pro: false, premium: true },
  notify_only_pending: { free: false, pro: true, premium: true },
  group_boost: { free: false, pro: true, premium: true },
  onboarding_call: { free: false, pro: false, premium: true },
  referral_storage_bonus: { free: true, pro: false, premium: false },
  daily_diary_reminder: { free: false, pro: true, premium: true },
};

export function hasFeature(plan: Plan, feature: PlanFeature): boolean {
  return FEATURE_ACCESS[feature][plan];
}

// ---------------------------------------------------------------------------
// หนูเก็บความทรงจำ — the diary-reminder ADD-ON (migration 052)
//
// An add-on, NOT a plan: any tier (free included) may hold it, and holding it
// changes nothing about `users.plan`. It is therefore absent from PLAN_PRICING,
// PLAN_FEATURES and planSummary() by design — putting it in any of those maps
// would make it look like something a tier grants.
//
// Distinct from the plan-based §17 `diary_reminders` quota above, which is a
// per-plan monthly allowance sent by the 20:00 sweep. The add-on is a paid,
// per-user, daily push at a time the user picks, and it has its own master
// switch (DIARY_ADDON_ENABLED) so it can ship while §17 stays off.
// ---------------------------------------------------------------------------

/**
 * Master switch for the add-on. Off unless DIARY_ADDON_ENABLED === 'true' on
 * BOTH Railway services (env is per-service — the worker does not inherit the
 * API's). While false the hourly sweep stands down and registers no schedule.
 *
 * DELIBERATE DEVIATION from this module's env-free rule (see the file header):
 * this is the one `process.env` read here, kept because every other plan/price
 * constant lives in this file and splitting the add-on's price away from its
 * flag would be worse. It is safe for the unit tests — an unset variable simply
 * resolves to `false`, so no .env is required to import this module.
 */
export const DIARY_ADDON_ENABLED = process.env.DIARY_ADDON_ENABLED === 'true';

/**
 * THB, whole Baht. Yearly ≈ 30.4 ฿/month — about 38 % off the monthly rate.
 * The ONLY place these numbers are written: the API serves them to the web,
 * which must never hard-code a price in a component.
 */
export const DIARY_ADDON_PRICE = {
  monthly: 49,
  yearly: 365,
} as const;

/** ชื่อที่แสดงกับผู้ใช้ — no emoji, same brand rule as PLAN_DISPLAY_NAME. */
export const DIARY_ADDON_DISPLAY_NAME = 'หนูเก็บความทรงจำ';

export function diaryAddonPrice(cycle: BillingCycle): number {
  return cycle === 'monthly' ? DIARY_ADDON_PRICE.monthly : DIARY_ADDON_PRICE.yearly;
}

/**
 * กล่องของขวัญ 15 กล่อง/เดือน — a perk bundled with the add-on.
 *
 * A FLOOR, never a replacement: see effectiveMonthlyLimit. The add-on lifts a
 * free (3) or pro (10) holder up to 15; a premium holder keeps their 30, because
 * an add-on that DOWNGRADED a paid tier's quota would be the worst possible
 * outcome of buying it.
 */
export const DIARY_ADDON_GIFT_BOX_QUOTA = 15;

/** Add-ons a user may hold, as far as quota resolution is concerned. */
export interface AddonContext {
  /** Holder of a LIVE หนูเก็บความทรงจำ subscription (status active + unexpired). */
  diaryAddon?: boolean;
}

/**
 * The monthly limit a user actually gets: their plan's limit, raised by any
 * add-on floor they hold.
 *
 * EVERY quota read/reserve goes through this, not through limitFor directly, so
 * the enforced limit and the limit the account page displays can never disagree.
 * UNLIMITED (-1) always wins — an add-on floor must not cap an uncapped plan.
 */
export function effectiveMonthlyLimit(
  plan: Plan,
  feature: MonthlyFeature,
  addons?: AddonContext,
): number {
  const base = MONTHLY_QUOTAS[feature][plan];
  if (isUnlimited(base)) return base;
  if (feature === 'gift_boxes' && addons?.diaryAddon) {
    return Math.max(base, DIARY_ADDON_GIFT_BOX_QUOTA);
  }
  return base;
}

// ---------------------------------------------------------------------------
// Retention + support (§12, §18)
// ---------------------------------------------------------------------------

/** §12 — days a soft-deleted item stays restorable before the purge job. */
export const TRASH_RETENTION_DAYS: Record<Plan, number> = {
  free: 5,
  pro: 30,
  premium: 30,
};

/** §18 — support SLA. Derived at ticket creation, never hard-coded at the route. */
export const SUPPORT_SLA_HOURS: Record<Plan, number> = {
  free: 24,
  pro: 24,
  premium: 4,
};

export function slaHoursFor(plan: Plan): number {
  return SUPPORT_SLA_HOURS[plan];
}

// ---------------------------------------------------------------------------
// Limit lookup
// ---------------------------------------------------------------------------

/** The limit for any quota-tracked feature. -1 = unlimited. */
export function limitFor(plan: Plan, feature: QuotaFeature): number {
  if (feature in MONTHLY_QUOTAS) {
    return MONTHLY_QUOTAS[feature as MonthlyFeature][plan];
  }
  return CAPACITY_LIMITS[feature as CapacityFeature][plan];
}

export function isMonthlyFeature(feature: QuotaFeature): feature is MonthlyFeature {
  return (MONTHLY_FEATURES as readonly string[]).includes(feature);
}

/**
 * Everything the UI needs to render a pricing table or an account page, built
 * from the tables above so the two can never drift.
 */
export interface PlanSummary {
  plan: Plan;
  /** ชื่อที่แสดงกับผู้ใช้ — no emoji, see PLAN_DISPLAY_NAME. */
  displayName: string;
  pricing: PlanPricing;
  lockerBytes: number;
  lockerMaxBytesWithReferrals: number;
  monthly: Record<MonthlyFeature, number>;
  capacity: Record<CapacityFeature, number>;
  features: Record<PlanFeature, boolean>;
  reminder: ReminderPolicy;
  trashRetentionDays: number;
  slaHours: number;
}

export function planSummary(plan: Plan): PlanSummary {
  return {
    plan,
    displayName: PLAN_DISPLAY_NAME[plan],
    pricing: PLAN_PRICING[plan],
    lockerBytes: lockerLimitBytes(plan, 0),
    lockerMaxBytesWithReferrals: lockerLimitBytes(plan, Number.MAX_SAFE_INTEGER),
    monthly: Object.fromEntries(
      MONTHLY_FEATURES.map((f) => [f, MONTHLY_QUOTAS[f][plan]]),
    ) as Record<MonthlyFeature, number>,
    capacity: Object.fromEntries(
      CAPACITY_FEATURES.map((f) => [f, CAPACITY_LIMITS[f][plan]]),
    ) as Record<CapacityFeature, number>,
    features: Object.fromEntries(
      PLAN_FEATURES.map((f) => [f, FEATURE_ACCESS[f][plan]]),
    ) as Record<PlanFeature, boolean>,
    reminder: REMINDER_POLICY[plan],
    trashRetentionDays: TRASH_RETENTION_DAYS[plan],
    slaHours: SUPPORT_SLA_HOURS[plan],
  };
}
