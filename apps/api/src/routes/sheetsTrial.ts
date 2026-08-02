/**
 * หนูเก็บลองงาน — the 14-day Google Sheets trial (migration 062).
 *
 * Two routes only: read the trial, start the trial. Everything else about the
 * integration — connect, status, disconnect, backfill — is unchanged and still
 * lives in routes/integrations.ts. There is deliberately no second OAuth entry
 * point and no second disconnect path: the trial does not change HOW Sheets is
 * connected, only WHO may connect it.
 *
 * The trial is not a purchase. It grants exactly one feature flag
 * (`google_sheets`) for a fixed window and touches nothing else — not
 * `users.plan`, not `subscriptions`, not a quota. It is therefore NOT in the
 * "Temporarily Disabled Endpoints" category that POST /plans/change and
 * POST /diary-addon/subscribe fall into: those two granted a PAID entitlement
 * with no payment behind them, which is a hole. Fourteen free days of one
 * feature, once per account, with a hard automatic cutoff, is the thing itself.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { SheetsTrialStatus } from '@nookeb/shared';
import { PLAN_DISPLAY_NAME, SHEETS_TRIAL_DAYS, SHEETS_TRIAL_DISPLAY_NAME, hasFeature } from '../config/plans';
import { isGoogleSheetsConfigured } from '../services/google-sheets.service';
import { activateTrial, resolveSheetsAccess } from '../services/sheets-trial.service';

const sheetsTrialRoutes: FastifyPluginAsync = async (app) => {
  // Same feature gate as the integration routes, and it must stay: offering a
  // trial of Sheets on a deployment with no Google OAuth client would let
  // someone spend their one lifetime activation on fourteen days of a button
  // that answers 503.
  app.addHook('onRequest', async (_request, reply) => {
    if (!isGoogleSheetsConfigured()) {
      return reply.code(503).send({
        error: 'ยังไม่เปิดให้เชื่อมต่อ Google Sheets น้า',
        code: 'GOOGLE_NOT_CONFIGURED',
      });
    }
  });

  app.addHook('preHandler', async (request, reply) => app.authenticate(request, reply));

  // ---- GET /integrations/google/trial ------------------------------------
  //
  // NEVER gated on entitlement — a user who cannot use Sheets is exactly the
  // user who needs to read this, and the card has to be able to render the
  // offer. Same reasoning as GET /diary-addon/status serving non-subscribers.
  app.get('/integrations/google/trial', async (request) => {
    const access = await resolveSheetsAccess(app.supabase, request.authUser!.userId);
    const status: SheetsTrialStatus = {
      name: SHEETS_TRIAL_DISPLAY_NAME,
      // Served rather than hard-coded in the component, so "14" exists once.
      trialDays: SHEETS_TRIAL_DAYS,
      trial: access.trial,
      access: { allowed: access.allowed, source: access.source },
      // Not offered to someone whose plan already includes Sheets — see
      // ALREADY_ENTITLED in the service. Also false on an un-migrated database,
      // where activation would 503 anyway.
      canActivate:
        access.migrated &&
        access.trial.activatedAt === null &&
        !hasFeature(access.plan, 'google_sheets'),
    };
    return status;
  });

  // ---- POST /integrations/google/trial/activate --------------------------
  //
  // ONE-SHOT, ENFORCED IN THE DATABASE. The service does a conditional UPDATE
  // on `sheets_trial_activated_at IS NULL`, so this is race-safe: two taps
  // 5 ms apart cannot both start a fourteen-day clock.
  //
  // The rate limit is a courtesy against a stuck button, not the guard. The
  // guard is the conditional update — a limiter can only slow an attacker down,
  // and "no reset, no extension" has to hold against someone calling this in a
  // loop for a week.
  app.post(
    '/integrations/google/trial/activate',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const result = await activateTrial(app.supabase, request.authUser!.userId);

      if (result.ok) {
        return reply.send({ trial: result.trial, expiresAt: result.trial.expiresAt });
      }

      switch (result.reason) {
        case 'ALREADY_USED':
          // 409, not 403: this is a state conflict, not an entitlement problem,
          // and the client must not offer "try again".
          return reply.code(409).send({
            error: `${SHEETS_TRIAL_DISPLAY_NAME} ใช้ได้ครั้งเดียวต่อบัญชีน้า — พี่เคยเริ่มไปแล้ว`,
            code: 'SHEETS_TRIAL_ALREADY_USED',
            trial: result.trial,
          });
        case 'ALREADY_ENTITLED':
          return reply.code(409).send({
            error: `แพ็กเกจ ${PLAN_DISPLAY_NAME.premium} ของพี่ใช้ Google Sheets ได้อยู่แล้วน้า — เก็บสิทธิ์ทดลองไว้ก่อนดีกว่า`,
            code: 'SHEETS_ALREADY_ENTITLED',
            trial: result.trial,
          });
        case 'NOT_MIGRATED':
          // Migration 062 has not been applied. Loud rather than silent: every
          // read path degrades quietly to "no trial", but an activation that
          // appeared to succeed and granted nothing would be far worse.
          app.log.error('sheets trial activation attempted before migration 062');
          return reply.code(503).send({
            error: 'ยังไม่เปิดให้ทดลองใช้ตอนนี้น้า',
            code: 'SHEETS_TRIAL_NOT_READY',
          });
      }
    },
  );
};

export default sheetsTrialRoutes;
