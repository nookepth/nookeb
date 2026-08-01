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
    case 'VAULT_FULL':
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
