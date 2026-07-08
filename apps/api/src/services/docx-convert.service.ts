import type { Redis } from 'ioredis';

/**
 * Convert-to-Word "arming" flag (the "แปลงไฟล์" command). Mirrors the scan
 * session's role but is a plain Redis key, not a DB row: the mode is a one-shot
 * "the NEXT image/PDF this user sends gets converted", so a TTL'd flag needs no
 * migration and self-expires if the user never sends a file. Personal-chat
 * only (like scan) — the webhook never checks it for group sources.
 */

const FLAG_TTL_SECONDS = 10 * 60;

const key = (lineUserId: string): string => `docx:pending:${lineUserId}`;

export async function armDocxConvert(redis: Redis, lineUserId: string): Promise<void> {
  await redis.set(key(lineUserId), '1', 'EX', FLAG_TTL_SECONDS);
}

export async function disarmDocxConvert(redis: Redis, lineUserId: string): Promise<void> {
  await redis.del(key(lineUserId));
}

/**
 * Consume the flag (returns whether it was set). GETDEL = atomic, so two
 * concurrent webhook events for the same user can't both claim the one shot.
 */
export async function consumeDocxConvert(redis: Redis, lineUserId: string): Promise<boolean> {
  const val = await redis.getdel(key(lineUserId));
  return val !== null;
}

export async function isDocxConvertArmed(redis: Redis, lineUserId: string): Promise<boolean> {
  return (await redis.exists(key(lineUserId))) === 1;
}
