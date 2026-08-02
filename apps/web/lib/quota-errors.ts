/**
 * ข้อความโควตา/แพ็กเกจ — the ONE place the web turns a machine error code into
 * something a person can read.
 *
 * Why this exists: the API answers a quota failure with a structured payload
 * (`{ error, code, feature, limit, used, reset_at }`) so clients can branch on
 * it. That payload is for code, not for people — a user who sees
 * "QUOTA_EXCEEDED" in a red box has been told nothing except that something
 * broke. Every quota/plan rejection in the dashboard funnels through here.
 *
 * Mirrors the Thai vocabulary of `apps/api/src/services/quota-message.ts`
 * (the LINE-side copy) so the bot and the web never describe the same limit in
 * two different ways.
 *
 * PURE — no React, no fetch, no env. Import it from anywhere.
 */

/** Feature key → the noun the sentence is about. Mirrors the API's FEATURE_LABEL. */
const FEATURE_LABEL: Record<string, string> = {
  scans: 'สแกน',
  pdf_merges: 'รวมไฟล์',
  word_conversion_pages: 'แปลงไฟล์เป็น Word',
  tasks: 'สร้างงาน',
  task_notifications: 'แจ้งเตือนงาน',
  gift_boxes: 'กล่องของขวัญ',
  group_files: 'เก็บไฟล์ในกลุ่ม',
  diary_reminders: 'เตือนเขียนไดอารี่',
  vault_files: 'ห้องนิรภัย',
  group_boosts: 'บูธกลุ่ม',
};

/** The safe default: an unrecognised plan must never claim a paid tier. */
const FREE_DISPLAY_NAME = 'หนูเก็บวัยเด็ก';

/** Plan key → the display name used everywhere in the UI. NO EMOJI — brand rule. */
export const PLAN_DISPLAY_NAME: Record<string, string | undefined> = {
  free: FREE_DISPLAY_NAME,
  pro: 'หนูเก็บโตแย้ว',
  premium: 'หนูเก็บแปลงร่าง',
  // Legacy rows from migration 001's original vocabulary are premium — same
  // normalisation the API does in config/plans.ts.
  team: 'หนูเก็บแปลงร่าง',
};

/** Display name for a raw `users.plan` value; unknown falls back to free. */
export function planDisplayName(plan: string | null | undefined): string {
  return PLAN_DISPLAY_NAME[plan ?? 'free'] ?? FREE_DISPLAY_NAME;
}

export interface QuotaMessage {
  title: string;
  subtitle: string;
}

/**
 * Monthly quota exhausted.
 *
 * `feature` is optional because some call sites only have the code (a 429 with
 * no body). Naming the feature is strictly better when we have it — "โควต้า
 * กล่องของขวัญเดือนนี้เต็มแล้ว" tells the user which limit they hit, and which
 * they still have.
 */
export function getQuotaMessage(feature?: string): QuotaMessage {
  const label = feature ? FEATURE_LABEL[feature] : undefined;
  return {
    title: label ? `โควต้า${label}เดือนนี้เต็มแล้วน้า` : 'โควต้าเดือนนี้เต็มแล้วน้า',
    subtitle: 'รีเซตใหม่ทุกต้นเดือน หรืออัปเกรดแพลนเพื่อใช้เพิ่ม',
  };
}

/**
 * Plan gate — the feature exists but this tier can't reach it.
 *
 * Distinct from a quota message on purpose: "wait until next month" is wrong
 * advice here, because waiting will never help.
 */
export function getPlanGateMessage(requiredPlan?: string): QuotaMessage {
  const name = requiredPlan ? PLAN_DISPLAY_NAME[requiredPlan] : undefined;
  return {
    title: 'ฟีเจอร์นี้ต้องการแพลนที่สูงกว่า',
    subtitle: name ? `อัปเกรดเป็น${name}เพื่อใช้งานฟีเจอร์นี้` : 'อัปเกรดเพื่อใช้งานฟีเจอร์นี้',
  };
}

/** Capacity limit (vault items, boosts) — never resets, so the advice differs. */
export function getCapacityMessage(feature?: string, limit?: number): QuotaMessage {
  const label = feature ? FEATURE_LABEL[feature] : undefined;
  return {
    title: label ? `${label}เต็มแล้วน้า` : 'เต็มแล้วน้า',
    subtitle:
      typeof limit === 'number'
        ? `แพลนนี้เก็บได้ ${limit} ชิ้น — ลบของเก่าออก หรืออัปเกรดแพลนน้า`
        : 'ลบของเก่าออก หรืออัปเกรดแพลนน้า',
  };
}

/**
 * The single entry point most call sites want: hand it an error code and get
 * back copy. Returns null for codes this module has no opinion about, so the
 * caller can fall through to its own message rather than showing a wrong one.
 */
export function messageForCode(
  code: string | undefined,
  opts: { feature?: string; requiredPlan?: string; limit?: number } = {},
): QuotaMessage | null {
  switch (code) {
    case 'QUOTA_EXCEEDED':
    case 'quota_exceeded':
      return getQuotaMessage(opts.feature);
    case 'PLAN_UPGRADE_REQUIRED':
      return getPlanGateMessage(opts.requiredPlan);
    // Two names for the same 403: the API sends `code: 'VAULT_FULL'` and
    // `errorCode: 'VAULT_FILE_LIMIT_REACHED'`. Both must land on the same copy.
    case 'VAULT_FULL':
    case 'VAULT_FILE_LIMIT_REACHED':
      return getCapacityMessage(opts.feature ?? 'vault_files', opts.limit);
    case 'BOOST_LIMIT_REACHED':
      return getCapacityMessage('group_boosts', opts.limit);
    default:
      return null;
  }
}

/** Flatten to one line for inline/toast surfaces that have no subtitle slot. */
export function flatten(message: QuotaMessage): string {
  return `${message.title} — ${message.subtitle}`;
}

/* ---------------------------------------------------------------------------
   Reset timing — "รีเซตอีก 9 วัน"
   --------------------------------------------------------------------------- */

/**
 * Days from now until the monthly counters roll over.
 *
 * Prefers the server's `reset_at` (GET /plans/me/quotas, and the body of every
 * 429) because that instant is computed in ICT by billing-period.ts and is the
 * one the counter actually obeys. The fallback — the 1st of the browser's next
 * month — is only for call sites that have the code but no payload; it can be
 * off by a few hours for a user in a distant timezone, which is acceptable for
 * a "อีก N วัน" hint but is why it is not the primary source.
 *
 * Always at least 1: "รีเซตอีก 0 วัน" reads as "already reset", and a user who
 * acts on that gets rejected again.
 */
export function daysUntilReset(resetAt?: string | null, now: Date = new Date()): number {
  let target: Date;
  if (resetAt) {
    const parsed = new Date(resetAt);
    target = Number.isNaN(parsed.getTime()) ? nextMonthStart(now) : parsed;
  } else {
    target = nextMonthStart(now);
  }
  const days = Math.ceil((target.getTime() - now.getTime()) / 86_400_000);
  return Math.max(1, days);
}

function nextMonthStart(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
}

/* ---------------------------------------------------------------------------
   "What upgrading buys you" lines
   --------------------------------------------------------------------------- */

/** The counting noun for a feature's unit — "10 กล่อง/เดือน" vs "10 ครั้ง/เดือน". */
const FEATURE_UNIT: Record<string, string> = {
  scans: 'ครั้ง',
  pdf_merges: 'ครั้ง',
  word_conversion_pages: 'หน้า',
  tasks: 'ชิ้น',
  task_notifications: 'ครั้ง',
  gift_boxes: 'กล่อง',
  group_files: 'ไฟล์',
  diary_reminders: 'ครั้ง',
  vault_files: 'ไฟล์',
  group_boosts: 'กลุ่ม',
};

/** The minimal shape `quotaUpgradeLines` needs — a subset of PlanSummaryDto. */
export interface PlanLimitSource {
  plan: string;
  displayName: string;
  monthly: Record<string, number>;
  capacity: Record<string, number>;
}

/**
 * "สร้างงานได้ 25 ชิ้น/เดือน (หนูเก็บโตแย้ว) หรือ 100 ชิ้น/เดือน (หนูเก็บแปลงร่าง)"
 *
 * Built from GET /plans, never from literals: the limits and the plan names
 * both live in apps/api/src/config/plans.ts, and a number typed into a
 * component is a promise the server never agreed to. Returns [] when the price
 * list has not arrived — showing no line is strictly better than showing a
 * guessed one.
 */
export function quotaUpgradeLines(
  feature: string,
  plans: readonly PlanLimitSource[] | null | undefined,
): string[] {
  if (!plans?.length) return [];
  const label = FEATURE_LABEL[feature];
  const unit = FEATURE_UNIT[feature] ?? 'ครั้ง';
  const monthly = feature in (plans[0]?.monthly ?? {});
  const paid = plans.filter((p) => p.plan === 'pro' || p.plan === 'premium');
  if (paid.length === 0) return [];

  const parts = paid
    .map((p) => {
      const limit = (monthly ? p.monthly : p.capacity)?.[feature];
      if (typeof limit !== 'number') return null;
      // -1 = UNLIMITED (config/plans.ts). Never render it as a number.
      const amount = limit < 0 ? 'ไม่จำกัด' : `${limit} ${unit}${monthly ? '/เดือน' : ''}`;
      return `${amount} (${p.displayName})`;
    })
    .filter((s): s is string => s !== null);
  if (parts.length === 0) return [];

  const verb = label ? `${label}ได้` : 'ใช้ได้';
  return [`${verb} ${parts.join(' หรือ ')}`];
}
