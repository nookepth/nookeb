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
import { logEvent } from '../services/events.service';

interface LineTokenResponse {
  access_token: string;
  id_token: string;
}

interface LineProfileResponse {
  userId: string;
  displayName: string;
  pictureUrl?: string;
}

// One-time log of the resolved request.ip so Railway logs can confirm the
// per-IP limiter keys on a real client address, not a shared proxy address.
// (trustProxy MUST stay `true` — see the comment in index.ts: `trustProxy: 1`
// resolves every Vercel-proxied dashboard request to Vercel's shared egress IP
// and the /auth/line 10/min + ban:5 limiter then bans ALL users at once.)
let loggedFirstRequestIp = false;

const authRoutes: FastifyPluginAsync = async (app) => {
  // Channel id used to verify LIFF id tokens at POST /auth/liff — the audience
  // (`aud`) LINE stamped into the token. Resolved ONCE (order: LINE_LIFF_ID
  // prefix → LINE_LIFF_CHANNEL_ID override → LINE_LOGIN_CHANNEL_ID fallback) and
  // logged at boot, because a stale LINE_LIFF_ID / LINE_LIFF_CHANNEL_ID left over
  // from the MINI App migration is the #1 cause of the ระบบตามงาน
  // "ต้องเชื่อมต่อ LINE" 401 loop (aud mismatch) — and it was previously only
  // visible as a per-request 401 warn. This value MUST equal the numeric prefix
  // of the LIFF id the web ships (NEXT_PUBLIC_LIFF_ID); if they differ, every
  // task page dead-ends. Reused by the handler so "logged == used".
  const liffVerifyChannelId =
    config.LINE_LIFF_ID?.split('-')[0] ||
    config.LINE_LIFF_CHANNEL_ID ||
    config.LINE_LOGIN_CHANNEL_ID;
  app.log.info(
    {
      liffVerifyChannelId: liffVerifyChannelId ?? '(none configured)',
      source: config.LINE_LIFF_ID
        ? 'LINE_LIFF_ID prefix'
        : config.LINE_LIFF_CHANNEL_ID
          ? 'LINE_LIFF_CHANNEL_ID'
          : 'LINE_LOGIN_CHANNEL_ID',
    },
    'auth/liff: resolved LIFF id-token verification channel at boot (must match NEXT_PUBLIC_LIFF_ID prefix)',
  );

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
    // See the audit-finding note above: confirm the resolved client IP once.
    if (!loggedFirstRequestIp) {
      loggedFirstRequestIp = true;
      app.log.info({ resolvedClientIp: request.ip }, 'auth: resolved request.ip for first /auth/line request (trustProxy=true)');
    }

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

    // 1. Exchange code for access token (15s timeout — a hung LINE token
    // endpoint must not pin the request; return 503 so the client can retry).
    let tokenRes: Response;
    try {
      tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: parsed.data.code,
          redirect_uri: parsed.data.redirectUri,
          client_id: loginChannelId,
          client_secret: loginChannelSecret,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        app.log.warn('LINE token exchange timed out after 15000ms');
        return reply.code(503).send({ error: 'LINE login temporarily unavailable' });
      }
      throw err;
    }
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
    // Analytics: dashboard login (web DAU signal). Best-effort — see events.service.
    void logEvent(app.supabase, {
      eventType: 'web_login',
      userId: user.id,
      source: 'web',
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

  // POST /auth/liff — LIFF id-token → app session cookie (ระบบตามงาน pages).
  // The LIFF SDK hands the page a signed id token; LINE's verify endpoint
  // checks signature/expiry/audience server-side, so this is as strong as the
  // authorization-code flow above.
  //
  // AUDIENCE: the id token's `aud` is the channel that HOSTS the LIFF — whatever
  // channel the LIFF id belongs to. A LIFF id is `{channelId}-{suffix}`, so its
  // numeric prefix IS the aud, whether the LIFF lives under a LINE MINI App
  // channel OR (after reverting the migration) the LINE Login channel. That
  // prefix is therefore the AUTHORITATIVE resolver and MUST win: a stale
  // LINE_LIFF_CHANNEL_ID left over from the MINI App era would otherwise verify
  // every (now Login-channel) token against the wrong aud → 401 → every task
  // page dead-ends on "ต้องเชื่อมต่อ LINE". Resolution order: prefix of
  // LINE_LIFF_ID → explicit LINE_LIFF_CHANNEL_ID (only used when LINE_LIFF_ID is
  // unset, e.g. a bare dev setup) → LINE Login channel id (final fallback). Same
  // abuse posture as /auth/line: 10/min per IP + ban.
  app.post('/auth/liff', {
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
    const bodySchema = z.object({ idToken: z.string().min(1) });
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body' });
    }
    // Channel the LIFF token was minted for (its `aud`) — resolved + logged once
    // at plugin boot above (liffVerifyChannelId), so the value verified here is
    // exactly the value the startup log reported.
    const liffChannelId = liffVerifyChannelId;
    if (!liffChannelId) {
      return reply.code(503).send({ error: 'LINE Login is not configured' });
    }

    // ─── [401-debug] TEMPORARY — remove once the ระบบตามงาน /auth/liff 401 loop
    // is diagnosed. JSON.stringify exposes stray whitespace/quotes in a
    // copy-pasted Railway env value (a hidden char makes the client_id look
    // correct in the dashboard yet fail verify). The token's own aud/exp are
    // decoded WITHOUT signature verification purely to log them, so an aud
    // mismatch or an expired token is visible without waiting on LINE. The raw
    // id token is deliberately NEVER logged.
    console.log('[401-debug] env LINE_LIFF_ID:', JSON.stringify(process.env.LINE_LIFF_ID));
    console.log('[401-debug] env LINE_LIFF_CHANNEL_ID:', JSON.stringify(process.env.LINE_LIFF_CHANNEL_ID));
    console.log(
      '[401-debug] resolved liffChannelId:',
      JSON.stringify(liffChannelId),
      'len=',
      liffChannelId.length,
    );
    try {
      const payloadB64 = parsed.data.idToken.split('.')[1] ?? '';
      const claimsPeek = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
        aud?: unknown;
        exp?: number;
        iss?: string;
      };
      const now = Math.floor(Date.now() / 1000);
      console.log(
        '[401-debug] token claims (unverified decode):',
        'aud=',
        JSON.stringify(claimsPeek.aud),
        'iss=',
        claimsPeek.iss,
        'exp=',
        claimsPeek.exp,
        claimsPeek.exp
          ? `(${claimsPeek.exp - now}s from now — ${claimsPeek.exp < now ? 'EXPIRED' : 'valid'})`
          : '(no exp)',
        'audMatchesClientId=',
        String(claimsPeek.aud) === liffChannelId,
      );
    } catch (e) {
      console.log('[401-debug] token payload decode failed:', (e as Error).message);
    }
    // ─── end [401-debug] ───

    let verifyRes: Response;
    try {
      verifyRes = await fetch('https://api.line.me/oauth2/v2.1/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ id_token: parsed.data.idToken, client_id: liffChannelId }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        app.log.warn('LIFF id-token verify timed out after 15000ms');
        return reply.code(503).send({ error: 'LINE login temporarily unavailable' });
      }
      throw err;
    }
    if (!verifyRes.ok) {
      // Surface the client_id used: a 400/401 here almost always means the
      // configured channel id doesn't match the token's `aud` — the #1 symptom
      // of a half-finished MINI App migration.
      const detail = await verifyRes.text().catch(() => '');
      // [401-debug] LINE's own reason (untruncated) — e.g. "IdToken expired." vs
      // a client_id/aud mismatch message. Remove with the debug block above.
      console.log('[401-debug] LINE verify FAILED — status=', verifyRes.status, 'body=', detail);
      app.log.warn(
        { status: verifyRes.status, verifyClientId: liffChannelId, detail: detail.slice(0, 300) },
        'LIFF id-token verify failed — check LINE_LIFF_CHANNEL_ID / LINE_LIFF_ID matches the MINI App channel',
      );
      return reply.code(401).send({ error: 'LIFF login failed' });
    }
    const claims = (await verifyRes.json()) as { sub: string; name?: string; picture?: string };

    const { user, space } = await ensureUserAndSpace(
      app.supabase,
      claims.sub,
      claims.name,
      claims.picture,
    );
    const accessToken = signAppToken({
      sub: user.id,
      lineUserId: user.line_user_id,
      sessionVersion: user.session_version ?? 1,
    });
    reply.setCookie(SESSION_COOKIE, accessToken, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    });
    return { user: toUserDto(user), defaultSpaceId: space.id };
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
