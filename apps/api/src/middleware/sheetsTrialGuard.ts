/**
 * Google Sheets access guard — plan OR หนูเก็บลองงาน trial (migration 062).
 *
 * This REPLACES `planGuard('google_sheets')` on every Sheets route. It is not an
 * additional gate stacked on top: `planGuard` refuses anyone below premium, so
 * leaving it in front would reject every trial user before this ever ran. There
 * must be exactly one entitlement check per route, and this is it.
 *
 * Middleware order is unchanged from the project convention:
 *   authenticate → sheetsTrialGuard → quotaCheck → handler
 *
 * ── Why an expired trial is its own status code ───────────────────────────
 *
 * A user who never started the trial and a user whose trial just ended are in
 * different situations and need different copy — "ทดลองฟรี 14 วัน" versus
 * "หมดอายุแล้ว". They also need different UI: an activate button versus an
 * upgrade link. Collapsing both into PLAN_UPGRADE_REQUIRED would offer a free
 * trial to someone who has already used theirs.
 *
 * Both are 403, never 401, matching the vault's convention (VAULT_LOCKED /
 * VAULT_PREMIUM_REQUIRED) and the suspension path's ACCOUNT_SUSPENDED. The
 * distinction is load-bearing on the client: the web treats 401 as "log in
 * again", which for an entitlement problem is an infinite loop through LINE
 * Login that can never resolve it.
 */

import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { PLAN_DISPLAY_NAME, SHEETS_TRIAL_DISPLAY_NAME } from '../config/plans';
import { resolveSheetsAccess, type SheetsAccessResult } from '../services/sheets-trial.service';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Resolved once by sheetsTrialGuard and reused by the handler, so a guarded
     * route never pays for the same lookup twice.
     */
    sheetsAccess?: SheetsAccessResult;
  }
}

/**
 * Resolve and cache Sheets entitlement on the request. Safe to call from both
 * the guard and the handler — the second call is free.
 *
 * Requires `authenticate` to have run. A missing authUser is a preHandler
 * ordering bug, so it throws rather than silently allowing — the same contract
 * as planGuard's `ensurePlan`.
 */
export async function ensureSheetsAccess(request: FastifyRequest): Promise<SheetsAccessResult> {
  if (request.sheetsAccess) return request.sheetsAccess;
  const auth = request.authUser;
  if (!auth) {
    throw new Error('sheetsTrialGuard: authenticate must run before any Sheets access check');
  }
  const access = await resolveSheetsAccess(request.server.supabase, auth.userId);
  request.sheetsAccess = access;
  return access;
}

/**
 * Guard a Sheets route behind "premium plan OR live trial".
 *
 *   app.get('/integrations/google/auth', {
 *     preHandler: [app.authenticate, sheetsTrialGuard()],
 *   }, handler);
 */
export function sheetsTrialGuard(): preHandlerHookHandler {
  return async function sheetsTrialGuardHandler(request: FastifyRequest, reply: FastifyReply) {
    const access = await ensureSheetsAccess(request);
    if (access.allowed) return;

    if (access.trial.isExpired) {
      return reply.code(403).send({
        error: `${SHEETS_TRIAL_DISPLAY_NAME} หมดอายุแล้วน้า อัปเกรดเป็นแพ็กเกจ ${PLAN_DISPLAY_NAME.premium} เพื่อใช้ต่อได้เลย`,
        code: 'SHEETS_TRIAL_EXPIRED',
        feature: 'google_sheets',
        current_plan: access.plan,
        required_plan: 'premium',
        trial: access.trial,
      });
    }

    // Never activated. Shape kept byte-compatible with planGuard's rejection —
    // the dashboard already branches on PLAN_UPGRADE_REQUIRED to open the
    // upgrade card, and that behaviour must not change for users who have no
    // trial in play.
    return reply.code(403).send({
      error: `เชื่อม Google Sheets ใช้ได้กับแพ็กเกจ ${PLAN_DISPLAY_NAME.premium} น้า — หรือลองฟรีก่อนก็ได้`,
      code: 'PLAN_UPGRADE_REQUIRED',
      feature: 'google_sheets',
      current_plan: access.plan,
      required_plan: 'premium',
      /** The client uses this to offer the trial instead of only an upgrade. */
      trial_available: access.migrated && access.trial.activatedAt === null,
      trial: access.trial,
    });
  };
}
