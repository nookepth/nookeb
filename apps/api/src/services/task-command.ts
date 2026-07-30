import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import type { RemindType } from '@nookeb/shared';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * ระบบตามงาน — "หนูเก็บเตือนงาน" in-chat command parser (pure / env-free, unit-
 * tested). Turns a LINE group text message + its inbound @mention metadata into
 * a structured task-create intent, or a typed error. Deliberately does NO I/O:
 * it never touches Supabase/Redis/LINE, so group-membership resolution and the
 * Pro plan gate stay in the webhook handler where the app context lives.
 *
 * The one trigger word "เตือนงาน" is BOTH the help card (when sent bare) and the
 * create command (when followed by @mentions + a task). "สั่งงาน" is still
 * accepted as a legacy alias so pinned/old messages keep working.
 *
 * Separation of concerns (same shape as pdf-merge / export / task-recurrence):
 *   parser  = text + mentionees  → intent (assignee uids, title, due, count)
 *   handler = intent             → membership resolve + Pro gate + create + reply
 */

export const BANGKOK_TZ = 'Asia/Bangkok';

/** Default due time (Bangkok wall clock) when the user gives a date but no time. */
export const DEFAULT_DUE_HOUR = 18;
export const DEFAULT_DUE_MINUTE = 0;

/** Hard cap on reminder shots (there are only four defined offsets). */
export const MAX_REMINDER_COUNT = 4;

/**
 * A LINE inbound mentionee (subset of the webhook payload). `userId` is present
 * ONLY when LINE could identify the mentioned person (they consented / the bot
 * can see them); its ABSENCE is precisely the "cannot be resolved" case. `type`
 * is 'all' for an @All mention, which carries no single assignee.
 */
export interface LineMentionee {
  index: number;
  length: number;
  userId?: string;
  type?: 'user' | 'all' | string;
}

export type TaskCommandErrorCode =
  | 'mention_all' // used @All — can't assign a task to everyone at once
  | 'unresolved_mention' // some mention has no userId (never spoke / not consented)
  | 'no_assignee' // no resolvable @mention at all
  | 'missing_due' // no ส่ง/กำหนด/ภายใน clause
  | 'invalid_due' // due clause present but unparseable, or in the past
  | 'no_title'; // nothing left as a task description

export interface ParsedTaskCommand {
  /** Deduped LINE user ids to assign (order preserved). */
  assigneeUids: string[];
  /** Task description (also the single item's title). */
  title: string;
  /** Resolved deadline as a UTC ISO string. */
  dueIso: string;
  /**
   * Reminder shots the user asked for (1..MAX), or null when unspecified.
   * The Pro gate + persistence live in the handler; the parser only reads it.
   */
  reminderCount: number | null;
}

export type TaskCommandParseResult =
  | { ok: true; value: ParsedTaskCommand }
  | { ok: false; code: TaskCommandErrorCode; unresolvedCount?: number };

export interface ParseTaskCommandInput {
  /** The RAW message.text — mention indices are offsets into THIS string. */
  text: string;
  mentionees?: LineMentionee[];
  /** Injected for deterministic tests; defaults to Date.now(). */
  nowMs?: number;
}

// ---- text hygiene ----

/** Strip zero-width chars (U+200B–U+200D, U+FEFF); NFC-normalize. Mirrors the
 * webhook's normalizeText so the two can't drift. Applied AFTER mention removal
 * so it can't shift LINE's UTF-16 mention indices. */
export function normalizeText(s: string): string {
  return s.replace(/[​-‍﻿]/g, '').normalize('NFC');
}

/**
 * Remove every mention substring from the raw text using LINE's index/length
 * (UTF-16 code units == JS string units; Thai + ASCII are all BMP). Processed
 * right-to-left so earlier indices stay valid. Defensive: an out-of-range span
 * is skipped rather than throwing, so a malformed payload degrades to leaving
 * that "@name" in the title instead of crashing.
 */
export function stripMentions(text: string, mentionees: LineMentionee[]): string {
  const spans = [...mentionees]
    .filter((m) => Number.isInteger(m.index) && Number.isInteger(m.length) && m.length > 0)
    .sort((a, b) => b.index - a.index);
  let out = text;
  for (const m of spans) {
    if (m.index < 0 || m.index + m.length > out.length) continue;
    out = out.slice(0, m.index) + ' ' + out.slice(m.index + m.length);
  }
  return out;
}

/**
 * Strip a leading "หนูเก็บ" address prefix and the command word. "เตือนงาน" is
 * the current trigger; "สั่งงาน" stays as a legacy alias. The longer "เตือนงาน"
 * is matched as a whole word, so it never collides with the "เตือน N ครั้ง"
 * reminder clause (which needs a digit after "เตือน" and is stripped later).
 */
function stripCommandWord(s: string): string {
  return s.replace(/^\s*(?:หนูเก็บ)?\s*(?:เตือนงาน|สั่งงาน)\s*/u, '');
}

// ---- reminder clause ----

const REMINDER_RE = /\s*เตือน\s*(\d+)\s*(?:ครั้ง|รอบ|ที)?/u;

/** Extract & remove a "เตือน N ครั้ง" clause. count is null when absent or 0. */
export function extractReminder(s: string): { rest: string; count: number | null } {
  const m = REMINDER_RE.exec(s);
  if (!m) return { rest: s, count: null };
  const n = Number(m[1]);
  const rest = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s+/gu, ' ').trim();
  return { rest, count: Number.isFinite(n) && n > 0 ? n : null };
}

// ---- due date clause ----

/** Due keywords, longest-first so "กำหนดส่ง" wins over "ส่ง"/"กำหนด" at a spot. */
const DUE_KEYWORDS = ['กำหนดส่ง', 'ภายในวันที่', 'กำหนด', 'ภายใน', 'ส่ง', 'due', 'deadline'];

const REL_DAYS: Record<string, number> = { วันนี้: 0, พรุ่งนี้: 1, มะรืนนี้: 2, มะรืน: 2 };

/**
 * Match a date/time expression at the START of `s`. Grammar:
 *   (relative | DD/MM[/YYYY])?  (HH:MM)?
 * with at least one component present. Returns the matched text + resolved
 * instant (Bangkok wall clock → UTC), or null when nothing valid leads `s`.
 */
export function matchDueExpression(
  s: string,
  nowMs: number,
): { matched: string; date: Date } | null {
  const re =
    /^\s*(?:(วันนี้|พรุ่งนี้|มะรืนนี้|มะรืน|อีก\s*\d+\s*วัน)|(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?)?\s*(?:(\d{1,2})[:.](\d{2}))?/u;
  const m = re.exec(s);
  if (!m) return null;
  const [, rel, dd, mm, yy, hh, min] = m;
  const hasDate = rel !== undefined || (dd !== undefined && mm !== undefined);
  const hasTime = hh !== undefined && min !== undefined;
  if (!hasDate && !hasTime) return null;

  const now = dayjs(nowMs).tz(BANGKOK_TZ);
  const hour = hasTime ? Number(hh) : DEFAULT_DUE_HOUR;
  const minute = hasTime ? Number(min) : DEFAULT_DUE_MINUTE;
  if (hour > 23 || minute > 59) return null;

  let d: dayjs.Dayjs;
  if (rel !== undefined) {
    const relTrim = rel.replace(/\s+/gu, '');
    let addDays: number;
    if (relTrim.startsWith('อีก')) {
      const n = Number(relTrim.replace(/\D+/gu, ''));
      if (!Number.isFinite(n) || n <= 0) return null;
      addDays = n;
    } else {
      addDays = REL_DAYS[relTrim] ?? 0;
    }
    d = now.add(addDays, 'day').hour(hour).minute(minute).second(0).millisecond(0);
  } else if (dd !== undefined && mm !== undefined) {
    const day = Number(dd);
    const month = Number(mm);
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;
    let year = now.year();
    if (yy !== undefined) {
      const raw = Number(yy);
      // 4-digit ≥ 2400 or any 2-digit is Buddhist (2568 → 2025; "68" → 2568 → 2025).
      if (yy.length <= 2) year = 2500 + raw - 543;
      else year = raw >= 2400 ? raw - 543 : raw;
    }
    d = now
      .year(year)
      .month(month - 1)
      .date(day)
      .hour(hour)
      .minute(minute)
      .second(0)
      .millisecond(0);
    // Day overflow guard (e.g. 31/04 → dayjs rolls to May) — reject rather than
    // silently move the deadline to a day the user didn't type.
    if (d.date() !== day || d.month() !== month - 1) return null;
    // No explicit year and the date already passed this year → assume next year.
    if (yy === undefined && d.valueOf() <= nowMs) d = d.add(1, 'year');
  } else {
    // Time only → today at that time, rolling to tomorrow if already past.
    d = now.hour(hour).minute(minute).second(0).millisecond(0);
    if (d.valueOf() <= nowMs) d = d.add(1, 'day');
  }

  return { matched: m[0], date: d.toDate() };
}

/**
 * Find the due clause: the LAST keyword occurrence whose trailing tokens parse
 * as a date. Returns the resolved date + the text with the whole clause removed.
 * `keywordSeen` distinguishes "they never wrote ส่ง" (missing) from "they did
 * but the date is junk" (invalid) so the handler can message precisely.
 */
export function extractDue(
  s: string,
  nowMs: number,
): { rest: string; date: Date | null; keywordSeen: boolean } {
  let best: { start: number; end: number; date: Date } | null = null;
  let keywordSeen = false;
  let i = 0;
  while (i < s.length) {
    let advanced = false;
    for (const kw of DUE_KEYWORDS) {
      if (!s.startsWith(kw, i)) continue;
      keywordSeen = true;
      const after = s.slice(i + kw.length);
      const match = matchDueExpression(after, nowMs);
      if (match && match.matched.trim().length > 0) {
        best = { start: i, end: i + kw.length + match.matched.length, date: match.date };
        // Skip past the whole clause so its inner keyword (the "ส่ง" inside
        // "กำหนดส่ง") isn't rematched and left as residue in the title.
        i = best.end;
        advanced = true;
      }
      break; // longest keyword tried first at this position
    }
    if (!advanced) i += 1;
  }
  if (!best) return { rest: s, date: null, keywordSeen };
  const rest = (s.slice(0, best.start) + ' ' + s.slice(best.end)).replace(/\s+/gu, ' ').trim();
  return { rest, date: best.date, keywordSeen };
}

// ---- reminder shot selection (used by the scheduler) ----

/**
 * Priority order for choosing WHICH reminder shots a count maps to: the day-
 * before nudge is the most useful single reminder, then 3h-before, then the
 * overdue poke, then the 3-day heads-up. `selectRemindTypes(2)` therefore fires
 * "1 วันก่อน" + "3 ชม.ก่อน". null/undefined = the full default schedule.
 */
export const REMIND_PRIORITY: RemindType[] = ['1_day', '3_hours', 'overdue', '3_days'];

export function selectRemindTypes(count: number | null | undefined): RemindType[] {
  if (count == null) return [...REMIND_PRIORITY];
  const n = Math.max(1, Math.min(MAX_REMINDER_COUNT, Math.floor(count)));
  return REMIND_PRIORITY.slice(0, n);
}

// ---- top-level parse ----

export function parseTaskCommand(input: ParseTaskCommandInput): TaskCommandParseResult {
  const nowMs = input.nowMs ?? Date.now();
  const mentionees = input.mentionees ?? [];

  // Mentions first — assigning silently to the wrong (or nobody) is the worst
  // failure, so surface these before anything about dates/titles.
  const hasAll = mentionees.some((m) => m.type === 'all');
  if (hasAll) return { ok: false, code: 'mention_all' };
  const unresolved = mentionees.filter((m) => m.type !== 'all' && !m.userId);
  if (unresolved.length > 0) {
    return { ok: false, code: 'unresolved_mention', unresolvedCount: unresolved.length };
  }
  const assigneeUids = [
    ...new Set(mentionees.filter((m) => m.userId).map((m) => m.userId as string)),
  ];
  if (assigneeUids.length === 0) return { ok: false, code: 'no_assignee' };

  // Body: strip mentions by index on the RAW text, THEN normalize, THEN drop the
  // command word. (Normalizing first could shift the UTF-16 mention indices.)
  let body = normalizeText(stripMentions(input.text, mentionees));
  body = stripCommandWord(body).replace(/\s+/gu, ' ').trim();

  const { rest: afterReminder, count } = extractReminder(body);
  const { rest: afterDue, date, keywordSeen } = extractDue(afterReminder, nowMs);

  if (!date) {
    return { ok: false, code: keywordSeen ? 'invalid_due' : 'missing_due' };
  }
  if (date.getTime() <= nowMs) return { ok: false, code: 'invalid_due' };

  const title = afterDue.replace(/\s+/gu, ' ').trim();
  if (title.length === 0) return { ok: false, code: 'no_title' };

  return {
    ok: true,
    value: { assigneeUids, title: title.slice(0, 200), dueIso: date.toISOString(), reminderCount: count },
  };
}
