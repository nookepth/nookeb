import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import {
  deleteIntegration,
  exchangeCode,
  getAuthUrl,
  getIntegration,
  isGoogleSheetsConfigured,
  saveIntegration,
} from '../services/google-sheets.service';
import { claimOAuthState, storeOAuthState } from '../services/google-oauth-state';

/**
 * Google Sheets integration (migration 046) — OAuth connect/disconnect.
 *
 * CSRF + identity: the OAuth `state` is a single-use nonce held in Redis and
 * bound to the caller's user id (see services/google-oauth-state.ts). The
 * callback trusts NOTHING from the query except that nonce, because Google will
 * happily deliver a `code` to this endpoint no matter who started the flow —
 * without the binding, an attacker could get a victim's browser to complete a
 * flow they started and graft THEIR Google account onto the victim's nookeb
 * account (or, worse in the other direction, their own account onto a victim's
 * tasks).
 *
 * The callback is the ONE route here that MUST NOT require a session: Google
 * redirects the BROWSER straight to `${APP_URL}/integrations/google/callback`
 * (the API host), but the HttpOnly session cookie is host-only on the WEB
 * origin — the dashboard obtains it through the same-origin `/api-proxy` rewrite,
 * so the browser never has that cookie on the API host and sends nothing on this
 * top-level redirect. Requiring auth here 401s every callback. The state nonce
 * IS the auth: it was minted while authenticated and carries the user id.
 */

const callbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
});

/** Bounce back to the dashboard with a result the UI can render. */
function settingsRedirect(status: 'connected' | 'error', reason?: string): string {
  const q = new URLSearchParams({ google: status });
  if (reason) q.set('reason', reason);
  return `${config.WEB_URL}/dashboard/settings?${q}`;
}

const integrationsRoutes: FastifyPluginAsync = async (app) => {
  // Feature gate: no OAuth client (or no VAULT_MASTER_KEY to encrypt the token
  // with) → the whole surface is unavailable, rather than half-working.
  app.addHook('onRequest', async (_request, reply) => {
    if (!isGoogleSheetsConfigured()) {
      return reply.code(503).send({
        error: 'ยังไม่เปิดให้เชื่อมต่อ Google Sheets น้า',
        code: 'GOOGLE_NOT_CONFIGURED',
      });
    }
  });

  // Auth is applied PER-ROUTE below, never as a plugin-wide hook: the callback
  // is a cookie-less top-level redirect from Google and must be reachable
  // without a session (see the file header). The other three routes are called
  // by the dashboard through the /api-proxy rewrite, where the session cookie is
  // present, so they require it.

  // GET /integrations/google — connection status for the dashboard card.
  // NEVER returns encrypted_token (or anything derived from it).
  app.get('/integrations/google', { preHandler: app.authenticate }, async (request) => {
    const row = await getIntegration(app.supabase, request.authUser!.userId);
    if (!row) return { connected: false };
    return {
      connected: true,
      email: row.google_email,
      sheetUrl: row.sheet_url,
      lastSyncedAt: row.last_synced_at,
      lastError: row.last_error,
    };
  });

  // GET /integrations/google/auth — mint a nonce, hand back the consent URL.
  //
  // Returns the URL as JSON instead of 302-ing: the dashboard calls this with
  // fetch() through the /api-proxy rewrite, where a redirect would be followed
  // by fetch and land Google's HTML in a JSON parse. The client does the
  // top-level navigation itself.
  app.get('/integrations/google/auth', { preHandler: app.authenticate }, async (request) => {
    const nonce = randomUUID();
    await storeOAuthState(app.redis, nonce, request.authUser!.userId);
    return { url: getAuthUrl(nonce) };
  });

  // GET /integrations/google/callback — Google redirects the BROWSER here.
  // Always ends in a redirect back to the dashboard (never JSON): the user is
  // looking at a real page, not an API response.
  app.get('/integrations/google/callback', async (request, reply) => {
    const parsed = callbackQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.redirect(settingsRedirect('error', 'bad_request'));
    const { code, state, error } = parsed.data;

    // The user pressed "Cancel" on the consent screen — not an error worth
    // shouting about.
    if (error || !code || !state) {
      return reply.redirect(settingsRedirect('error', error === 'access_denied' ? 'denied' : 'no_code'));
    }

    // The nonce is the ONLY trusted identity here (no session cookie survives the
    // cross-origin redirect — see the file header). GETDEL claims it single-use,
    // so a replayed callback finds nothing. An unknown/expired/already-used nonce
    // → reject; nobody can complete a flow they didn't start.
    const boundUserId = await claimOAuthState(app.redis, state);
    if (!boundUserId) {
      app.log.warn('google oauth callback with unknown/expired/used state — rejected');
      return reply.redirect(settingsRedirect('error', 'state_mismatch'));
    }

    try {
      const { refreshToken, email } = await exchangeCode(code);
      await saveIntegration(app.supabase, boundUserId, refreshToken, email);
    } catch (err) {
      // Never log `err` verbatim at error level here — a googleapis error can
      // carry the token exchange payload.
      app.log.error(
        { userId: boundUserId, message: (err as Error).message },
        'google oauth token exchange failed',
      );
      return reply.redirect(settingsRedirect('error', 'exchange_failed'));
    }
    return reply.redirect(settingsRedirect('connected'));
  });

  // DELETE /integrations/google — disconnect. Removes the credential row only:
  // the user's spreadsheet is theirs and stays exactly as it is, and their
  // tasks are untouched.
  app.delete('/integrations/google', { preHandler: app.authenticate }, async (request) => {
    await deleteIntegration(app.supabase, request.authUser!.userId);
    return { success: true };
  });
};

export default integrationsRoutes;
