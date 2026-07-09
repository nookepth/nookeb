import type { Redis } from 'ioredis';

/**
 * Diary "arming" flag (the "ไดอารี่" command) — same one-shot pattern as
 * docx-convert.service: a TTL'd Redis key meaning "the NEXT image this user
 * sends becomes today's diary entry". Personal-chat only (the webhook never
 * checks it for group sources). Unlike the docx flag, the value carries state:
 * a caption typed while armed is stored on the flag and travels into the
 * create_diary_entry job when the photo arrives.
 */

const FLAG_TTL_SECONDS = 10 * 60;

export interface DiaryModeState {
  caption?: string;
}

const key = (lineUserId: string): string => `diary:pending:${lineUserId}`;

export async function armDiaryMode(redis: Redis, lineUserId: string): Promise<void> {
  await redis.set(key(lineUserId), JSON.stringify({}), 'EX', FLAG_TTL_SECONDS);
}

export async function disarmDiaryMode(redis: Redis, lineUserId: string): Promise<void> {
  await redis.del(key(lineUserId));
}

/**
 * Consume the flag (GETDEL = atomic, so two concurrent image events can't both
 * claim the one shot). Returns the armed state, or null when not armed.
 */
export async function consumeDiaryMode(
  redis: Redis,
  lineUserId: string,
): Promise<DiaryModeState | null> {
  const val = await redis.getdel(key(lineUserId));
  if (val === null) return null;
  try {
    return JSON.parse(val) as DiaryModeState;
  } catch {
    return {};
  }
}

export async function isDiaryModeArmed(redis: Redis, lineUserId: string): Promise<boolean> {
  return (await redis.exists(key(lineUserId))) === 1;
}

/**
 * Store the caption on the armed flag (text typed while diary mode is armed).
 * SET XX KEEPTTL only rewrites an EXISTING key without resetting its expiry, so
 * a caption can never re-arm a flag that just expired or extend the window.
 * Returns whether the flag was still armed.
 */
export async function setDiaryCaption(
  redis: Redis,
  lineUserId: string,
  caption: string,
): Promise<boolean> {
  const state: DiaryModeState = { caption };
  // ioredis has no typed overload for the XX+KEEPTTL combination — go through
  // the generic call(). Redis parses SET options in any order.
  const result = await redis.call('SET', key(lineUserId), JSON.stringify(state), 'XX', 'KEEPTTL');
  return result === 'OK';
}
