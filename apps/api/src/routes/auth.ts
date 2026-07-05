import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { toUserDto, type SpaceRecord, type UserRecord } from '@nookeb/shared';
import { config, isAdminLineUser } from '../config';
import {
  SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  signAppToken,
} from '../middleware/auth';
import { ensureUserAndSpace } from '../services/file.service';

interface LineTokenResponse {
  access_token: string;
  id_token: string;
}

interface LineProfileResponse {
  userId: string;
  displayName: string;
  pictureUrl?: string;
}

const authRoutes: FastifyPluginAsync = async (app) => {
  // POST /auth/line — exchange LINE Login authorization code → app JWT.
  // Stricter limit than the global 100/min: this endpoint can be used to
  // hammer-probe LINE authorization codes, so 10/min per IP with a ban after
  // 5 consecutive over-limit hits.
  app.post('/auth/line', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
        ban: 5,
        errorResponseBuilder: () => ({
          statusCode: 429,
          error: 'Too Many Requests',
          message: 'Rate limit exceeded',
        }),
      },
    },
  }, async (request, reply) => {
    const bodySchema = z.object({
      code: z.string().min(1),
      redirectUri: z.string().url(),
    });
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }

    const loginChannelId = config.LINE_LOGIN_CHANNEL_ID;
    const loginChannelSecret = config.LINE_LOGIN_CHANNEL_SECRET;
    if (!loginChannelId || !loginChannelSecret) {
      return reply.code(503).send({ error: 'LINE Login is not configured' });
    }

    // 1. Exchange code for access token
    const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: parsed.data.code,
        redirect_uri: parsed.data.redirectUri,
        client_id: loginChannelId,
        client_secret: loginChannelSecret,
      }),
    });
    if (!tokenRes.ok) {
      app.log.warn({ status: tokenRes.status }, 'LINE token exchange failed');
      return reply.code(401).send({ error: 'LINE login failed' });
    }
    const tokens = (await tokenRes.json()) as LineTokenResponse;

    // 2. Fetch LINE profile
    const profileRes = await fetch('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!profileRes.ok) {
      return reply.code(401).send({ error: 'LINE profile fetch failed' });
    }
    const profile = (await profileRes.json()) as LineProfileResponse;

    // 3. Upsert user + personal space, issue app JWT
    const { user, space } = await ensureUserAndSpace(
      app.supabase,
      profile.userId,
      profile.displayName,
      profile.pictureUrl,
    );

    const accessToken = signAppToken({
      sub: user.id,
      lineUserId: user.line_user_id,
      sessionVersion: user.session_version ?? 1,
    });
    // FIX #7: the session travels in an HttpOnly cookie — JS can never read it.
    // SameSite=Lax works because the dashboard calls the API same-origin via
    // the Next.js /api-proxy rewrite. `secure` only in production: the Lax
    // cookie is set on http://localhost:3000 in dev.
    reply.setCookie(SESSION_COOKIE, accessToken, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    });
    // accessToken stays in the body for backward compatibility with web
    // bundles deployed before the cookie rollout (they still use Bearer auth).
    // Safe to drop once every client is on the cookie flow.
    return {
      accessToken,
      user: toUserDto(user),
      defaultSpaceId: space.id,
    };
  });

  // POST /auth/logout — clear the session cookie. No auth required: clearing a
  // cookie that is missing/expired/invalid must still succeed (the web calls
  // this on any 401 to shed a stale cookie).
  app.post('/auth/logout', async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  // GET /auth/me — current user profile + default space
  app.get('/auth/me', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.authUser!.userId;

    const { data: user, error } = await app.supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    if (!user) return reply.code(404).send({ error: 'User not found' });

    const { data: memberRows, error: memberErr } = await app.supabase
      .from('space_members')
      .select('space_id, spaces!inner(*)')
      .eq('user_id', userId)
      .eq('spaces.type', 'personal')
      .limit(1);
    if (memberErr) throw memberErr;

    const memberRow = memberRows?.[0] as { spaces: SpaceRecord } | undefined;
    return {
      ...toUserDto(user as UserRecord),
      defaultSpaceId: memberRow?.spaces.id ?? null,
      isAdmin: isAdminLineUser((user as UserRecord).line_user_id),
    };
  });
};

export default authRoutes;
