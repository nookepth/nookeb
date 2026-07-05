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
    const decoded = jwt.verify(token, config.JWT_SECRET) as jwt.JwtPayload;
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

/**
 * Current session_version for a user, cached in Redis for 60s — so a bump
 * (e.g. removal from a team) revokes outstanding JWTs within a minute without
 * a DB read on every request.
 */
async function getSessionVersion(app: FastifyInstance, userId: string): Promise<number> {
  const cacheKey = `sv:${userId}`;
  const cached = await app.redis.get(cacheKey);
  if (cached !== null) return Number(cached);

  const { data, error } = await app.supabase
    .from('users')
    .select('session_version')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  const version = (data?.session_version as number | undefined) ?? 1;
  await app.redis.set(cacheKey, String(version), 'EX', SESSION_VERSION_CACHE_TTL_SECONDS);
  return version;
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
    const token =
      request.cookies?.[SESSION_COOKIE] ??
      (header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null);

    const user = token ? verifyAppToken(token) : null;
    if (!user) {
      await reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    // Revocation check: token's session version must match the user's current
    // one. A mismatch means the version was bumped after this token was signed.
    const currentVersion = await getSessionVersion(app, user.userId);
    if (user.sessionVersion !== currentVersion) {
      await reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    request.authUser = { userId: user.userId, lineUserId: user.lineUserId };
  });
});
