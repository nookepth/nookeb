import type { Redis } from 'ioredis';
import { extractDue, matchDueExpression } from './task-command';

/**
 * ระบบตามงาน — pending "confirm before create" state for the in-chat task flow.
 * A command (strict "หนูเก็บเตือนงาน …" OR a natural-language detection) no longer
 * creates the task immediately: it stashes the parsed intent in Redis and replies
 * a confirmation card. The task is created only when the commander taps ยืนยัน.
 *
 * Two short-lived keys, both scoped to (group, commander) so a member can only
 * ever have ONE pending item and a new command REPLACES the old one:
 *
 *   nookeb:confirm:{groupId}:{commanderId}   — a fully-parsed intent awaiting the
 *                                              ยืนยัน / ยกเลิก postback.
 *   nookeb:taskpartial:{groupId}:{commanderId} — a natural-language MEDIUM intent
 *                                              (assignee + title, NO due) awaiting
 *                                              the commander's next message as the
 *                                              due date (one follow-up only).
 *
 * All values are JSON. This module does the Redis I/O + the pure date-completion
 * math; the LINE reply/card lives in the handler (task-command-handlers.ts).
 */

/** Both pending states expire in 5 minutes (spec) — a stale command is discarded. */
export const PENDING_TTL_SECONDS = 5 * 60;

/** Assignee snapshot resolved once (name/avatar) so confirm needs no LINE call. */
export interface StoredAssignee {
  lineUid: string;
  displayName: string | null;
  pictureUrl: string | null;
}

/** A fully-parsed, Pro-gated intent awaiting the ยืนยัน / ยกเลิก tap. */
export interface PendingTaskConfirm {
  groupId: string;
  commanderId: string;
  assignees: StoredAssignee[];
  title: string;
  dueIso: string;
  /** EFFECTIVE count after the Pro gate (null = default schedule / blocked). */
  reminderCount: number | null;
  /** True when the user asked for a custom count but isn't Pro (card shows a note). */
  reminderBlocked: boolean;
  /** LINE message.id of the originating command — the create idempotency key. */
  sourceMessageId: string;
}

/** A natural-language MEDIUM intent still missing its due date. */
export interface PendingTaskPartial {
  groupId: string;
  commanderId: string;
  assignees: StoredAssignee[];
  title: string;
  reminderCount: number | null;
  sourceMessageId: string;
}

// ---- key builders ----

export function confirmKey(groupId: string, commanderId: string): string {
  return `nookeb:confirm:${groupId}:${commanderId}`;
}

export function partialKey(groupId: string, commanderId: string): string {
  return `nookeb:taskpartial:${groupId}:${commanderId}`;
}

/**
 * Parse the commanderId out of a confirm key (`nookeb:confirm:{group}:{cmder}`).
 * The group id may itself contain colons in theory, so we take the LAST segment
 * as the commander and the middle as the group — but callers should VALIDATE by
 * reconstructing the key from the live event rather than trusting a parse.
 */
export function isConfirmKey(key: string): boolean {
  return key.startsWith('nookeb:confirm:');
}

// ---- pure JSON parse (shared so null/corrupt handling can't drift) ----

function parsePending<T>(val: string | null): T | null {
  if (val === null) return null;
  try {
    return JSON.parse(val) as T;
  } catch {
    return null;
  }
}

// ---- confirm state ----

/**
 * Store a pending confirmation, REPLACING any prior confirm OR partial for the
 * same (group, commander) — a fresh command always supersedes an in-flight one.
 */
export async function storePendingConfirm(redis: Redis, intent: PendingTaskConfirm): Promise<void> {
  const k = confirmKey(intent.groupId, intent.commanderId);
  await redis.set(k, JSON.stringify(intent), 'EX', PENDING_TTL_SECONDS);
  // A new full command also clears any half-finished NL partial for this user.
  await redis.del(partialKey(intent.groupId, intent.commanderId)).catch(() => {});
}

/** Read a pending confirmation (null when expired / missing / corrupt). */
export async function getPendingConfirm(
  redis: Redis,
  groupId: string,
  commanderId: string,
): Promise<PendingTaskConfirm | null> {
  return parsePending<PendingTaskConfirm>(await redis.get(confirmKey(groupId, commanderId)));
}

/**
 * Atomically claim (read + delete) a pending confirmation — used by the ยืนยัน
 * handler so a double-tap / redelivery can't create the task twice (GETDEL means
 * exactly one caller gets the value). Returns null when already used / expired.
 */
export async function claimPendingConfirm(
  redis: Redis,
  groupId: string,
  commanderId: string,
): Promise<PendingTaskConfirm | null> {
  return parsePending<PendingTaskConfirm>(await redis.getdel(confirmKey(groupId, commanderId)));
}

/** Put a claimed confirmation back (create failed → let the user retry ยืนยัน). */
export async function restorePendingConfirm(redis: Redis, intent: PendingTaskConfirm): Promise<void> {
  await redis.set(
    confirmKey(intent.groupId, intent.commanderId),
    JSON.stringify(intent),
    'EX',
    PENDING_TTL_SECONDS,
  );
}

/** Delete a pending confirmation (the ยกเลิก handler). */
export async function deletePendingConfirm(
  redis: Redis,
  groupId: string,
  commanderId: string,
): Promise<void> {
  await redis.del(confirmKey(groupId, commanderId));
}

// ---- partial (awaiting-due) state ----

/** Store an NL MEDIUM intent, replacing any prior confirm/partial for the user. */
export async function storePendingPartial(redis: Redis, partial: PendingTaskPartial): Promise<void> {
  const k = partialKey(partial.groupId, partial.commanderId);
  await redis.set(k, JSON.stringify(partial), 'EX', PENDING_TTL_SECONDS);
  await redis.del(confirmKey(partial.groupId, partial.commanderId)).catch(() => {});
}

/** Read a pending partial (null when expired / missing / corrupt). */
export async function getPendingPartial(
  redis: Redis,
  groupId: string,
  commanderId: string,
): Promise<PendingTaskPartial | null> {
  return parsePending<PendingTaskPartial>(await redis.get(partialKey(groupId, commanderId)));
}

/** Delete a pending partial. */
export async function deletePendingPartial(
  redis: Redis,
  groupId: string,
  commanderId: string,
): Promise<void> {
  await redis.del(partialKey(groupId, commanderId));
}

// ---- pure completion math ----

/**
 * Try to read a due date out of the commander's follow-up reply (the answer to
 * "จะให้ …ส่งเมื่อไหร่คะ?"). Accepts both a bare date ("พรุ่งนี้ 17:00", "25/12")
 * and one led by a keyword ("ส่งพรุ่งนี้") — the same grammar the strict parser
 * uses. Returns a resolved UTC ISO string for a FUTURE instant, else null (the
 * handler then stays silent rather than asking again — one follow-up max).
 */
export function parseDueReply(text: string, nowMs: number): string | null {
  const cleaned = text.replace(/[​-‍﻿]/g, '').normalize('NFC').trim();
  // First try a bare date/time at the very start of the message.
  const bare = matchDueExpression(cleaned, nowMs);
  if (bare && bare.matched.trim().length > 0 && bare.date.getTime() > nowMs) {
    return bare.date.toISOString();
  }
  // Then a keyword-led clause anywhere ("ส่งพรุ่งนี้", "ภายใน 25/12").
  const { date } = extractDue(cleaned, nowMs);
  if (date && date.getTime() > nowMs) return date.toISOString();
  return null;
}

/**
 * Complete an NL partial with a parsed due date into a full (un-gated) confirm
 * intent, or null when the reply carries no usable future date. The Pro gate for
 * reminderCount is applied later in the handler (needs the DB), so the returned
 * intent still carries the raw requested count + reminderBlocked=false as a
 * placeholder — the handler overwrites both before storing.
 */
export function completePartialWithDue(
  partial: PendingTaskPartial,
  replyText: string,
  nowMs: number,
): Omit<PendingTaskConfirm, 'reminderBlocked'> | null {
  const dueIso = parseDueReply(replyText, nowMs);
  if (!dueIso) return null;
  return {
    groupId: partial.groupId,
    commanderId: partial.commanderId,
    assignees: partial.assignees,
    title: partial.title,
    dueIso,
    reminderCount: partial.reminderCount,
    sourceMessageId: partial.sourceMessageId,
  };
}
