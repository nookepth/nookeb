import fp from 'fastify-plugin';
import jwt from 'jsonwebtoken';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import type { AuthUser } from '../types';

interface TokenPayload {
  sub: string; // users.id
  lineUserId: string;
  /** users.session_version at sign time — bumping the column revokes the token. */
  sessionVersion: number;
}

const SESSION_VERSION_CACHE_TTL_SECONDS = 60;

/**
 * HttpOnly session cookie carrying the app JWT (FIX #7). Set by POST
 * /auth/line, cleared by POST /auth/logout. The dashboard reaches the API
 * same-origin via the Next.js /api-proxy rewrite, so SameSite=Lax cookies flow
 * on every request and client-side JS can never read the token.
 */
export const SESSION_COOKIE = 'nookeb_session';
/** Matches the JWT's own 24h expiry. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24;

export function signAppToken(payload: TokenPayload): string {
  return jwt.sign(
    { lineUserId: payload.lineUserId, sv: payload.sessionVersion },
    config.JWT_SECRET,
    {
      subject: payload.sub,
      expiresIn: '24h',
    },
  );
}

export function verifyAppToken(token: string): (AuthUser & { sessionVersion: number }) | null {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (!decoded.sub || typeof decoded['lineUserId'] !== 'string') return null;
    return {
      userId: decoded.sub,
      lineUserId: decoded['lineUserId'],
      // Tokens signed before the session-version rollout have no `sv` claim;
      // 0 can never match a DB value (column starts at 1), so they are
      // rejected and the user simply re-logs-in once.
      sessionVersion: typeof decoded['sv'] === 'number' ? decoded['sv'] : 0,
    };
  } catch {
    return null;
  }
}

/** What the per-request account check needs to know, and nothing more. */
interface SessionState {
  version: number;
  suspended: boolean;
}

/**
 * Current session_version AND suspension state for a user, cached in Redis for
 * 60s — so a bump (e.g. removal from a team) revokes outstanding JWTs within a
 * minute without a DB read on every request.
 *
 * SUSPENSION RIDES THE SAME CACHE ENTRY AND THE SAME QUERY (migration 060).
 * A second Redis GET and a second SELECT on the hottest path in the API would
 * be the obvious way to add the check and the wrong one: the two facts are read
 * together, invalidated together, and neither is meaningful without the other.
 * One row, one key.
 *
 * CACHE FORMAT is `"{version}:{0|1}"` rather than JSON, and the parse is
 * BACKWARD COMPATIBLE with the bare `"{version}"` this key used to hold. That
 * matters for exactly one window — the minutes after this deploy, while entries
 * written by the previous version are still live — and the fallback is the safe
 * one: an old entry has no suspension byte and is read as NOT suspended, which
 * is what every user was when it was written. The entry expires within 60 s
 * regardless.
 *
 * `bustSessionCache` in routes/admin.ts deletes this same key, so the suspend
 * endpoint's revocation clears both halves at once.
 */
async function getSessionState(app: FastifyInstance, userId: string): Promise<SessionState> {
  const cacheKey = `sv:${userId}`;
  const cached = await app.redis.get(cacheKey);
  if (cached !== null) {
    const [rawVersion, rawSuspended] = cached.split(':');
    const version = Number(rawVersion);
    // A malformed entry falls through to the DB rather than being trusted: a
    // NaN version would compare unequal to every token and lock the user out.
    if (Number.isFinite(version)) {
      return { version, suspended: rawSuspended === '1' };
    }
  }

  const { data, error } = await app.supabase
    .from('users')
    .select('session_version, suspended_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  const version = (data?.session_version as number | undefined) ?? 1;
  // `undefined` (migration 060 not applied yet) and SQL NULL both mean "not
  // suspended". The reverse deploy order therefore degrades to today's
  // behaviour rather than throwing on a column that does not exist.
  const suspended = Boolean(data?.suspended_at as string | null | undefined);

  await app.redis.set(
    cacheKey,
    `${version}:${suspended ? '1' : '0'}`,
    'EX',
    SESSION_VERSION_CACHE_TTL_SECONDS,
  );
  return { version, suspended };
}

export default fp(async (app) => {
  app.decorateRequest('authUser', null);

  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    // Session JWTs are accepted via the HttpOnly session cookie (primary — set
    // by POST /auth/line) or the Authorization header (kept for older web
    // bundles during the transition). Never via the URL, where they would leak
    // into browser history and request logs. Browser download navigation uses
    // one-time ?dl_token= tokens instead (see routes/files.ts).
    const header = request.headers.authorization;
    const cookieToken = request.cookies?.[SESSION_COOKIE] ?? null;
    const bearerToken = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;

    // Try the cookie first; if it's missing/expired/invalid, fall through to the
    // Bearer token so a stale cookie can't mask a valid Authorization header.
    let user = cookieToken ? verifyAppToken(cookieToken) : null;
    if (!user && bearerToken) {
      user = verifyAppToken(bearerToken);
    }
    if (!user) {
      await reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    // Revocation check: token's session version must match the user's current
    // one. A mismatch means the version was bumped after this token was signed.
    const state = await getSessionState(app, user.userId);
    if (user.sessionVersion !== state.version) {
      await reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    // Account suspension (migration 060). AFTER the revocation check, because a
    // forged or expired token must not be told anything about the account it
    // claims to be — 401 first, then 403.
    //
    // 403, NOT 401, and the distinction is load-bearing on the client: the web
    // app treats 401 as "log in again", which for a suspended user is an
    // infinite loop through LINE Login that ends back here. 403 with a `code`
    // is the same shape the vault's lock states use (VAULT_LOCKED /
    // VAULT_PREMIUM_REQUIRED) for exactly this reason — a state re-authenticating
    // cannot fix.
    //
    // The suspension is enforced HERE, in the one place every authenticated
    // request passes through, and that is the whole extent of it: the LINE
    // webhook is signature-authenticated and never reaches this middleware, so
    // a suspended user can still message the OA. Deliberate — see the column
    // comment in migration 060. Cutting the chat path would silently swallow
    // uploads a user believes were saved, and needs its own design.
    if (state.suspended) {
      await reply.code(403).send({ error: 'ACCOUNT_SUSPENDED' });
      return;
    }

    request.authUser = {
      userId: user.userId,
      lineUserId: user.lineUserId,
      sessionVersion: user.sessionVersion,
    };
  });
});
