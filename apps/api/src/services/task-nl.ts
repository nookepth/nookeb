import {
  extractDue,
  extractReminder,
  normalizeText,
  stripMentions,
  type LineMentionee,
} from './task-command';

/**
 * ระบบตามงาน — LIGHTWEIGHT natural-language task detection (pure / env-free,
 * unit-tested). A deliberate HEURISTIC layer, NOT an NLP system: it turns an
 * un-prefixed group message that @mentions someone into a task-create intent
 * ONLY when it is confident, and otherwise does nothing. The strict
 * "หนูเก็บเตือนงาน …" command (task-command.ts) is untouched — this only adds a
 * best-effort path for messages that never used the trigger word.
 *
 * It reuses the SAME primitives as the strict parser (stripMentions /
 * extractReminder / extractDue) so the two can never disagree about how a
 * mention span, a "เตือน N ครั้ง" clause, or a "ส่ง …" due clause is read.
 *
 * Confidence (see detectNaturalTask):
 *   HIGH   — assignee + title + a real due clause → straight to the confirm card.
 *   MEDIUM — assignee + a task-shaped title, NO due → ask ONE follow-up (the due).
 *   LOW    — no resolvable assignee, or no task-shaped title → return null (ignore).
 *
 * Every path still ends at the confirmation card in the handler — NL never
 * creates a task directly. "If unsure, do nothing" is the governing rule, so the
 * gates below err toward LOW (silence) rather than a wrong guess.
 */

export type NlConfidence = 'high' | 'medium';

export interface NlDetection {
  confidence: NlConfidence;
  /** Deduped LINE user ids of resolvable @mentions (order preserved). */
  assigneeUids: string[];
  /** Task description (mentions + clauses removed). */
  title: string;
  /** Present ONLY for HIGH confidence (a due clause parsed to a future instant). */
  dueIso?: string;
  /** "เตือน N ครั้ง" count if present (Pro-gated later), else null. */
  reminderCount: number | null;
}

export interface DetectNaturalTaskInput {
  /** RAW message.text — mention indices are offsets into THIS string. */
  text: string;
  mentionees?: LineMentionee[];
  nowMs?: number;
}

/**
 * A short list of Thai/English verbs that read as "I'm handing someone a task".
 * Used ONLY to gate MEDIUM confidence: with no due date, an @mention + free text
 * is ambiguous (could be "@Bob 555" chatter), so we require one of these before
 * asking a follow-up question — that keeps the bot from interjecting on ordinary
 * group talk. HIGH confidence needs no gate: a due clause ("ส่งพรุ่งนี้") is
 * itself strong task intent.
 */
const TASK_INTENT_KEYWORDS = [
  'ทำ',
  'ส่ง',
  'ช่วย',
  'จัด',
  'เตรียม',
  'สรุป',
  'เขียน',
  'แก้',
  'รบกวน',
  'ฝาก',
  'อัพเดท',
  'อัปเดต',
  'เช็ค',
  'ตรวจ',
  'ติดตาม',
  'นัด',
  'ประชุม',
  'รายงาน',
  'งาน',
  'report',
  'send',
  'prepare',
  'review',
  'update',
];

/** Minimum meaningful title length (a 1-char remnant isn't a task description). */
const MIN_TITLE_LEN = 2;

function hasTaskIntent(title: string): boolean {
  const low = title.toLowerCase();
  return TASK_INTENT_KEYWORDS.some((kw) => low.includes(kw));
}

/**
 * Resolve the @mention list into deduped assignee uids under the SAME safety
 * rules the strict parser uses, but expressed as "ignore vs proceed" rather than
 * typed errors (NL must fail silent). An @All mention makes the whole message
 * ineligible (assigning to everyone off a guess is the worst outcome); a mention
 * we can't resolve is simply dropped — the confirmation card lists exactly who
 * WILL be assigned, so the human still catches a wrong/partial set.
 */
function resolveAssigneeUids(mentionees: LineMentionee[]): string[] | null {
  if (mentionees.some((m) => m.type === 'all')) return null;
  const uids = [...new Set(mentionees.filter((m) => m.userId).map((m) => m.userId as string))];
  return uids.length > 0 ? uids : null;
}

/**
 * Attempt a natural-language task parse. Returns null for LOW confidence (the
 * caller stays silent). NEVER throws — a malformed payload degrades to null.
 */
export function detectNaturalTask(input: DetectNaturalTaskInput): NlDetection | null {
  const nowMs = input.nowMs ?? Date.now();
  const mentionees = input.mentionees ?? [];

  const assigneeUids = resolveAssigneeUids(mentionees);
  if (!assigneeUids) return null; // no resolvable assignee / used @All → ignore

  // Same order as the strict parser: strip mentions on the RAW text by index,
  // THEN normalize (normalizing first could shift LINE's UTF-16 mention offsets).
  const body = normalizeText(stripMentions(input.text, mentionees)).replace(/\s+/gu, ' ').trim();

  const { rest: afterReminder, count } = extractReminder(body);
  // extractDue strips a "ส่ง …/กำหนด …" clause whenever it parses to a date — even
  // a PAST one — so the title is clean either way. `date` is only non-null when a
  // clause parsed; it may still be in the past (rejected for HIGH below).
  const { rest: afterDue, date } = extractDue(afterReminder, nowMs);
  const title = afterDue.replace(/\s+/gu, ' ').trim();
  if (title.length < MIN_TITLE_LEN) return null; // no clear title → LOW

  // HIGH: a real, FUTURE due clause + a title.
  if (date && date.getTime() > nowMs) {
    return {
      confidence: 'high',
      assigneeUids,
      title: title.slice(0, 200),
      dueIso: date.toISOString(),
      reminderCount: count,
    };
  }

  // MEDIUM: task-shaped title, no usable due date. Gated by a task-intent verb so
  // ordinary "@someone <chatter>" doesn't trigger a follow-up question.
  if (hasTaskIntent(title)) {
    return {
      confidence: 'medium',
      assigneeUids,
      title: title.slice(0, 200),
      reminderCount: count,
    };
  }

  return null; // LOW → do nothing
}
