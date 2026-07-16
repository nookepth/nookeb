import type { Redis } from 'ioredis';

/**
 * Vault unlock sessions + PIN brute-force lockout (ห้องนิรภัย), all in Redis.
 *
 * A 6-digit PIN has only 1,000,000 combinations — the lockout below is what
 * makes it safe, so it is keyed per USER, never per IP (every dashboard
 * request arrives through the Vercel /api-proxy hop; see the trustProxy
 * comment in index.ts for why IP identity is unreliable here).
 *
 * Unlock session: `vault_session:{userId}` holds the session_version the JWT
 * carried at unlock time, TTL 15 min sliding on every guarded vault call.
 * Because `authenticate` already rejects JWTs whose session_version is stale,
 * comparing the stored value against the CURRENT request's version makes a
 * bumped session_version (logout-everywhere) invalidate open vaults too.
 *
 * Lockout: 5 wrong PINs → 15-minute lock, doubling per repeat lockout
 * (15m → 30m → 60m → ...) within a 24h escalation memory.
 */

const SESSION_TTL_SECONDS = 900; // 15 minutes, slid on each guarded call
const MAX_ATTEMPTS = 5;
const BASE_LOCKOUT_SECONDS = 15 * 60;
const MAX_LOCKOUT_SECONDS = 24 * 60 * 60;
/** How long repeat-lockout escalation is remembered. */
const LOCKOUT_MEMORY_SECONDS = 24 * 60 * 60;
/** Attempts counter lives this long — stale near-miss counts eventually reset. */
const ATTEMPTS_TTL_SECONDS = 60 * 60;

export const VAULT_SESSION_TTL_SECONDS = SESSION_TTL_SECONDS;

const sessionKey = (userId: string): string => `vault_session:${userId}`;
const attemptsKey = (userId: string): string => `vault_unlock_attempts:${userId}`;
const lockedKey = (userId: string): string => `vault_unlock_locked:${userId}`;
const lockCountKey = (userId: string): string => `vault_unlock_lockcount:${userId}`;

/** Seconds until the lockout lifts, or 0 when not locked. */
export async function getLockoutRemaining(redis: Redis, userId: string): Promise<number> {
  const ttl = await redis.ttl(lockedKey(userId));
  return ttl > 0 ? ttl : 0;
}

export interface FailedAttemptResult {
  /** Attempts left before the next failure locks the vault (0 = now locked). */
  attemptsRemaining: number;
  /** Set when THIS failure triggered a lockout. */
  lockedForSeconds: number | null;
}

/**
 * Record one wrong PIN. On the 5th failure, starts a lockout whose duration
 * doubles for every lockout within the 24h escalation window.
 */
export async function recordFailedAttempt(
  redis: Redis,
  userId: string,
): Promise<FailedAttemptResult> {
  const attempts = await redis.incr(attemptsKey(userId));
  if (attempts === 1) {
    await redis.expire(attemptsKey(userId), ATTEMPTS_TTL_SECONDS);
  }
  if (attempts < MAX_ATTEMPTS) {
    return { attemptsRemaining: MAX_ATTEMPTS - attempts, lockedForSeconds: null };
  }

  const lockouts = await redis.incr(lockCountKey(userId));
  await redis.expire(lockCountKey(userId), LOCKOUT_MEMORY_SECONDS);
  const duration = Math.min(
    BASE_LOCKOUT_SECONDS * 2 ** (lockouts - 1),
    MAX_LOCKOUT_SECONDS,
  );
  await redis.set(lockedKey(userId), '1', 'EX', duration);
  await redis.del(attemptsKey(userId));
  return { attemptsRemaining: 0, lockedForSeconds: duration };
}

/** Correct PIN — clear the near-miss counter (escalation memory stays). */
export async function clearFailedAttempts(redis: Redis, userId: string): Promise<void> {
  await redis.del(attemptsKey(userId));
}

/** Open a 15-minute unlock session bound to the JWT's session_version. */
export async function openVaultSession(
  redis: Redis,
  userId: string,
  sessionVersion: number,
): Promise<void> {
  await redis.set(sessionKey(userId), String(sessionVersion), 'EX', SESSION_TTL_SECONDS);
}

/**
 * Is the vault unlocked for this request? Valid only while the stored
 * session_version matches the (already-authenticated) JWT's — a mismatch
 * means a revocation happened after unlock, so the session is torn down.
 * Slides the TTL on success.
 */
export async function checkVaultSession(
  redis: Redis,
  userId: string,
  sessionVersion: number,
): Promise<boolean> {
  const stored = await redis.get(sessionKey(userId));
  if (stored === null) return false;
  if (stored !== String(sessionVersion)) {
    await redis.del(sessionKey(userId));
    return false;
  }
  await redis.expire(sessionKey(userId), SESSION_TTL_SECONDS);
  return true;
}

export async function closeVaultSession(redis: Redis, userId: string): Promise<void> {
  await redis.del(sessionKey(userId));
}

/**
 * Non-sliding read for GET /vault/session-status: remaining unlock seconds, or
 * null when locked/expired/stale. Deliberately does NOT refresh the TTL — the
 * web polls this every 60s, and a sliding read here would keep an abandoned
 * vault open forever.
 */
export async function peekVaultSession(
  redis: Redis,
  userId: string,
  sessionVersion: number,
): Promise<number | null> {
  const key = sessionKey(userId);
  const [stored, ttl] = await Promise.all([redis.get(key), redis.ttl(key)]);
  if (stored === null || ttl <= 0) return null;
  if (stored !== String(sessionVersion)) return null;
  return ttl;
}
