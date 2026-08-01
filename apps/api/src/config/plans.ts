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
  pro: { monthly: 59, yearly: 599 },
  premium: { monthly: 129, yearly: 1290 },
};

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
 * §4b — the ONLY selectable intervals, in hours before the deadline. This is a
 * closed set rendered as checkboxes; free text is never accepted. Mirrored by
 * the `tasks_reminder_intervals_check` constraint in migration 051.
 *
 * EVERY PLAN SEES THE SAME FIVE OPTIONS. Plans differ only in how many boxes
 * may be ticked — there is no per-plan menu and no plan-specific shot.
 */
export const REMINDER_INTERVAL_CHOICES = [3, 6, 24, 48, 72] as const;
export type ReminderInterval = (typeof REMINDER_INTERVAL_CHOICES)[number];

export interface ReminderPolicy {
  /**
   * §4b — how many of the five checkboxes the plan may tick.
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
