import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import {
  SHEET_TITLE,
  deleteIntegration,
  exchangeCode,
  getAuthUrl,
  getIntegration,
  isGoogleSheetsConfigured,
  markRevokePending,
  recordOrphanedGrant,
  revokeRefreshToken,
  saveIntegration,
} from '../services/google-sheets.service';
import { claimOAuthState, storeOAuthState } from '../services/google-oauth-state';
import { enqueueHistoricalSync } from '../services/sheetsQueue';
import { sheetsTrialGuard } from '../middleware/sheetsTrialGuard';
import { resolveSheetsAccess } from '../services/sheets-trial.service';

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
  //
  // Not entitlement-gated: a user whose trial has ended must still be able to
  // read this and see that they are disconnected. The `trial` block rides along
  // so the card renders in one round trip instead of two.
  app.get('/integrations/google', { preHandler: app.authenticate }, async (request) => {
    const [row, access] = await Promise.all([
      getIntegration(app.supabase, request.authUser!.userId),
      resolveSheetsAccess(app.supabase, request.authUser!.userId),
    ]);
    const trialBlock = {
      trial: access.trial,
      access: { allowed: access.allowed, source: access.source },
    };
    if (!row) return { connected: false, ...trialBlock };
    return {
      connected: true,
      email: row.google_email,
      // A constant, not user input — the spreadsheet is always created with
      // this title (createSheet). Served so the UI never re-types it.
      //
      // NULL UNTIL THE SHEET ACTUALLY EXISTS. `sheet_id` is only written by the
      // first sync, which happens on the user's next task write — so between
      // completing OAuth and that write there is a connection but no
      // spreadsheet. Naming a file that has not been created yet would send the
      // user looking in their Drive for something that is not there.
      sheetName: row.sheet_id ? SHEET_TITLE : null,
      sheetId: row.sheet_id,
      sheetUrl: row.sheet_url,
      lastSyncedAt: row.last_synced_at,
      lastError: row.last_error,
      ...trialBlock,
    };
  });

  // GET /integrations/google/auth — mint a nonce, hand back the consent URL.
  //
  // Returns the URL as JSON instead of 302-ing: the dashboard calls this with
  // fetch() through the /api-proxy rewrite, where a redirect would be followed
  // by fetch and land Google's HTML in a JSON parse. The client does the
  // top-level navigation itself.
  //
  // §15 — PREMIUM, or a live หนูเก็บลองงาน trial (migration 062). Gated at the
  // point the flow STARTS, so an unentitled user never reaches Google's consent
  // screen and is never asked to grant access the product will then refuse to
  // use.
  //
  // sheetsTrialGuard REPLACES planGuard('google_sheets') here — it is not
  // stacked in front of it. planGuard refuses everyone below premium, so
  // leaving it would reject every trial user before the trial was ever
  // considered.
  app.get('/integrations/google/auth', {
    preHandler: [app.authenticate, sheetsTrialGuard()],
  }, async (request) => {
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

    // §15 re-check. No middleware can run here (no session survives Google's
    // redirect — see the file header), and the nonce may have been minted
    // before a downgrade, so the entitlement is verified against the bound user
    // just before the token is stored. Storing a refresh token for a user who
    // may not use the feature would be collecting a third-party credential for
    // nothing.
    //
    // This ALSO closes the trial's own edge: a user can start the OAuth trip
    // with minutes left on the clock and finish it after the trial has expired.
    // resolveSheetsAccess compares `expires_at` against the current instant, so
    // that lands here as a refusal rather than as a stored token the sweep then
    // has to come back and destroy.
    const access = await resolveSheetsAccess(app.supabase, boundUserId);
    if (!access.allowed) {
      return reply.redirect(
        settingsRedirect('error', access.trial.isExpired ? 'trial_expired' : 'plan_required'),
      );
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

  // POST /integrations/google/sync-historical — backfill the tasks the user
  // created BEFORE they connected (the event-driven sync only ever writes tasks
  // that change after the connect).
  //
  // Queued, never inline, for the same three reasons every other sync is (see
  // sheetsQueue.ts) plus one of its own: a full backfill is hundreds of Sheets
  // calls and would blow past any sane request timeout. The response therefore
  // says "accepted", not "imported N" — the count lands in the sheet's own
  // dashboard line and in `lastSyncedAt` here.
  //
  // Rate limit: this is the most expensive button in the product, and the
  // duplicate guard means a second press seconds later has nothing to do.
  app.post(
    '/integrations/google/sync-historical',
    {
      // Trial-aware, same swap as /auth above.
      preHandler: [app.authenticate, sheetsTrialGuard()],
      config: { rateLimit: { max: 3, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      const row = await getIntegration(app.supabase, request.authUser!.userId);
      if (!row) {
        return reply.code(409).send({
          error: 'ยังไม่ได้เชื่อมต่อ Google น้า',
          code: 'GOOGLE_NOT_CONNECTED',
        });
      }
      enqueueHistoricalSync(request.authUser!.userId);
      return { queued: true };
    },
  );

  // DELETE /integrations/google — disconnect. Removes the credential row only:
  // the user's spreadsheet is theirs and stays exactly as it is, and their
  // tasks are untouched.
  //
  // ── FIX 1: REVOKE AT GOOGLE FIRST, ALWAYS ────────────────────────────────
  //
  // This used to call deleteIntegration() straight away. The encrypted row is
  // the ONLY copy of the refresh token, so that destroyed our ability to ever
  // revoke the grant while leaving the grant itself alive at Google forever —
  // unrecoverably, because there was nothing left to revoke WITH. The automatic
  // trial-expiry sweep has always had this ordering right
  // (jobs/sheetsTrialExpiry.job.ts); the manual path did not, and a user who
  // presses "ยกเลิกการเชื่อมต่อ" has asked for exactly the same thing.
  //
  // The ordering below is identical to the sweep's, deliberately: revoke →
  // delete → done, and a transient failure deletes NOTHING.
  //
  // ── What a transient failure must not do ─────────────────────────────────
  //
  // Unlike the sweep, there is a user waiting on this response, and the two
  // easy answers are both wrong: deleting anyway is the leak being fixed, and
  // answering `{ success: true }` while doing nothing is worse still, because
  // the user now believes their Google account is disconnected when it is not.
  //
  // So the row is PARKED (`revoke_pending_at`, migration 063). That makes the
  // disconnect real immediately — getIntegration() hides parked rows, so the
  // dashboard shows disconnected and both sheetsWorker paths stop syncing — while
  // the encrypted token survives just long enough for the 15-minute retry pass
  // to finish revoking it at Google. The response says `pending`, not `success`.
  app.delete('/integrations/google', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.authUser!.userId;
    const row = await getIntegration(app.supabase, userId);

    // Already disconnected (or already parked, which getIntegration reports as
    // disconnected). Idempotent: a second press is a no-op, not a 404.
    if (!row) return { success: true, revoked: false };

    const outcome = await revokeRefreshToken(userId, row.encrypted_token, 'manual_disconnect');

    // FIX 2 — the token would not decrypt, so this grant can never be revoked
    // by us. Before the three-state result this arrived as success and the row
    // was deleted, losing the only trace of a live grant on the user's Google
    // account. Record it durably FIRST; the record is what makes deleting the
    // dead row acceptable, so a failed record leaves everything in place.
    if (outcome === 'DECRYPT_FAILED_PERMANENT') {
      const recorded = await recordOrphanedGrant(app.supabase, {
        userId,
        googleEmail: row.google_email,
        context: 'manual_disconnect',
        detail: 'manual disconnect: stored refresh token would not decrypt',
      });
      if (!recorded) {
        request.log.error(
          { userId },
          'ALERT unrevocable grant could not be recorded — credential left in place',
        );
        return reply.code(503).send({
          success: false,
          code: 'DISCONNECT_UNAVAILABLE',
          message: 'ตอนนี้หนูตัดการเชื่อมต่อให้ไม่ได้น้า ลองใหม่อีกครั้งนะ',
        });
      }
      await deleteIntegration(app.supabase, userId);
      // Honest: the connection is gone from our side, but the permission at
      // Google is NOT something we were able to hand back. Telling the user
      // where to finish the job is the only remedy left.
      return reply.code(200).send({
        success: true,
        revoked: false,
        code: 'GRANT_NOT_REVOKED',
        message:
          'หนูตัดการเชื่อมต่อให้แล้วน้า แต่คืนสิทธิ์ให้อัตโนมัติไม่ได้ — ' +
          'รบกวนพี่เข้าไปลบสิทธิ์ของหนูเก็บที่ myaccount.google.com/permissions ด้วยน้า',
      });
    }

    if (outcome === 'REVOKE_FAILED_TRANSIENT') {
      const parked = await markRevokePending(
        app.supabase,
        userId,
        'manual disconnect: google revoke unreachable',
      );
      if (parked) {
        request.log.warn(
          { userId },
          'manual disconnect parked — google revoke failed, retry pass will finish it',
        );
        // 202: accepted and in progress. The user IS disconnected (nothing will
        // sync, the card reads disconnected); what is still outstanding is the
        // revocation at Google, which is ours to finish, not theirs to retry.
        return reply.code(202).send({
          success: false,
          pending: true,
          code: 'DISCONNECT_REVOKE_PENDING',
          message:
            'หนูตัดการเชื่อมต่อให้แล้วน้า แต่ยังคืนสิทธิ์กับ Google ไม่สำเร็จ — หนูจะลองใหม่ให้อัตโนมัติภายใน 15 นาทีน้า',
        });
      }

      // Pre-063: there is nowhere to park it. Fall back to the OLD behaviour
      // rather than refusing to disconnect at all — an un-migrated deployment
      // keeps exactly the leak it already had, which is a worse outcome than a
      // working disconnect but a much better one than a disconnect button that
      // does not work.
      request.log.error(
        { userId },
        'manual disconnect: google revoke failed and migration 063 is not applied — ' +
          'deleting the credential anyway, the grant at Google is now UNREVOCABLE',
      );
    }

    await deleteIntegration(app.supabase, userId);
    return { success: true, revoked: outcome === 'REVOKED_SUCCESS' };
  });
};

export default integrationsRoutes;
