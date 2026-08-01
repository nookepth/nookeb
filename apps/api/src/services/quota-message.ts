/**
 * Thai copy for quota rejections delivered over LINE.
 *
 * PURE AND ENV-FREE (project rule 14) — string building only, so it is unit
 * testable and safe to import from the webhook, the worker and the routes.
 *
 * The web API answers quota failures with the structured JSON payload the spec
 * mandates ({ error, feature, limit, used, reset_at }). A LINE user gets a
 * sentence instead: the bot has no status codes, and "QUOTA_EXCEEDED" in a chat
 * bubble is not an answer. Both come from the same QuotaState so the numbers
 * can never disagree.
 */

import type { QuotaFeature } from '../config/plans';

/** Feature → the noun the sentence is about. */
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

/** Unit word, so "10 หน้า" reads right and "10 ครั้ง" does too. */
const FEATURE_UNIT: Record<string, string> = {
  word_conversion_pages: 'หน้า',
  vault_files: 'ไฟล์',
  group_files: 'ไฟล์',
  group_boosts: 'กลุ่ม',
};

function labelOf(feature: QuotaFeature | string): string {
  return FEATURE_LABEL[feature] ?? String(feature);
}

function unitOf(feature: QuotaFeature | string): string {
  return FEATURE_UNIT[feature] ?? 'ครั้ง';
}

/**
 * Bangkok wall-clock date of an ISO instant, as `D/M` — used to say when the
 * quota comes back. Deliberately not a full timestamp: "1/9" is what the user
 * needs, and a time-of-day invites questions about timezones.
 */
function bangkokDayMonth(iso: string): string {
  const d = new Date(Date.parse(iso) + 7 * 60 * 60 * 1000);
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
}

export interface QuotaMessageInput {
  feature: QuotaFeature | string;
  limit: number;
  used: number;
  /** ISO reset instant; null for capacity limits, which never reset. */
  resetAt: string | null;
}

/**
 * "โควตาสแกนเดือนนี้ครบ 10 ครั้งแล้วน้า เริ่มใหม่วันที่ 1/9 น้า …"
 *
 * Always names the number, because a limit the user cannot see is
 * indistinguishable from a bug.
 */
export function quotaExceededThai(input: QuotaMessageInput): string {
  const label = labelOf(input.feature);
  const unit = unitOf(input.feature);

  if (input.resetAt === null) {
    // Capacity limit — there is no reset, only deleting something.
    return (
      `${label}เต็มแล้วน้า แพ็กเกจนี้เก็บได้ ${input.limit} ${unit} ` +
      `ลบของเก่าออกก่อน หรืออัปเกรดแพ็กเกจเพื่อเพิ่มพื้นที่ได้น้า`
    );
  }

  return (
    `โควตา${label}เดือนนี้ครบ ${input.limit} ${unit} แล้วน้า ` +
    `เริ่มนับใหม่วันที่ ${bangkokDayMonth(input.resetAt)} น้า ` +
    `ถ้าอยากใช้ต่อเลย อัปเกรดแพ็กเกจได้น้า ✨`
  );
}

/**
 * Soft warning when the user is close to the edge. Returns null when there is
 * nothing worth saying — callers append it to an existing reply rather than
 * sending a second message (project rule 10: reply-only, one reply per event).
 */
export function quotaWarningThai(input: QuotaMessageInput): string | null {
  if (input.limit < 0) return null; // unlimited
  const remaining = input.limit - input.used;
  if (remaining > 2 || remaining < 0) return null;
  if (remaining === 0) return null; // the exceeded message covers this
  return `\n(เหลือโควตา${labelOf(input.feature)}อีก ${remaining} ${unitOf(input.feature)}เดือนนี้น้า)`;
}
