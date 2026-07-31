import type { Redis } from 'ioredis';

/**
 * Google OAuth `state` store (migration 046 connect flow).
 *
 * WHY THIS EXISTS AS THE CALLBACK'S ONLY AUTH:
 * The consent URL is minted at `/integrations/google/auth`, which the dashboard
 * calls through the Next.js `/api-proxy` rewrite — same-origin with the web app,
 * so the HttpOnly session cookie is present and the caller is authenticated
 * there. Google then redirects the BROWSER to
 * `${APP_URL}/integrations/google/callback`, a top-level navigation straight to
 * the API host. The session cookie is host-only and lives on the WEB origin
 * (Vercel), not the API host (Railway) — a different registrable domain — so the
 * browser sends NO cookie and NO Authorization header on that callback. The
 * callback therefore cannot require a JWT; it must not.
 *
 * The `state` nonce carries the identity instead: an unguessable, single-use
 * token minted while authenticated and bound to the caller's user id in Redis.
 * On the callback we GETDEL it — proving (a) the flow was started by a real
 * session (CSRF guard: an attacker can't forge a nonce we issued) and (b) which
 * user it belongs to. GETDEL makes it single-use, so a replayed callback finds
 * nothing and is rejected.
 *
 * Pure and Redis-injected so it is unit-testable with a fake client (rule §14).
 */

/** 10 min — a consent screen doesn't take longer, and a short window limits the
 * blast radius of a leaked nonce. */
export const OAUTH_STATE_TTL_SECONDS = 600;

export const oauthStateKey = (nonce: string): string => `google:oauth:state:${nonce}`;

/** Bind a freshly minted nonce to the authenticated caller's user id. */
export async function storeOAuthState(
  redis: Pick<Redis, 'set'>,
  nonce: string,
  userId: string,
): Promise<void> {
  await redis.set(oauthStateKey(nonce), userId, 'EX', OAUTH_STATE_TTL_SECONDS);
}

/**
 * Consume a nonce on the callback. GETDEL: returns the bound user id and deletes
 * the key atomically, so it can be claimed exactly once. Returns null when the
 * nonce is unknown, already used, or expired — every one of which the caller
 * must treat as an auth failure.
 */
export async function claimOAuthState(
  redis: Pick<Redis, 'getdel'>,
  nonce: string,
): Promise<string | null> {
  return redis.getdel(oauthStateKey(nonce));
}
