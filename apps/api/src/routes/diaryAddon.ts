/**
 * /diary-addon — หนูเก็บความทรงจำ, the standalone diary-reminder add-on
 * (migration 052).
 *
 * Every price served here comes from config/plans.ts (DIARY_ADDON_PRICE). If a
 * number in this file looks like a literal, it is a bug.
 *
 * NO PAYMENT PROVIDER EXISTS. POST /diary-addon/subscribe therefore now answers
 * 503 BILLING_NOT_READY unconditionally — as written it granted a paid add-on
 * for free to anyone who could call it. The original body is commented out in
 * place; re-enable it only behind a verified payment webhook.
 * See "Temporarily Disabled Endpoints" in CLAUDE.md.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  DIARY_ADDON_ENABLED,
  DIARY_ADDON_PRICE,
  DIARY_ADDON_DISPLAY_NAME,
  DIARY_ADDON_GIFT_BOX_QUOTA,
} from '../config/plans';
import {
  InvalidNotifyTimeError,
  cancelSubscription,
  createSubscription,
  getAddonStatus,
  setNotifyTime,
  toHhMm,
  type DiaryAddonSubscriptionRecord,
} from '../services/diaryAddon.service';

const subscribeSchema = z.object({
  billingCycle: z.enum(['monthly', 'yearly']),
});

const notifyTimeSchema = z.object({
  notifyTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

/** Whole days from now until `expiresAt`, floored at 0 (never negative). */
function daysLeft(expiresAt: string, now: Date): number {
  const ms = new Date(expiresAt).getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

function toDto(row: DiaryAddonSubscriptionRecord, now: Date) {
  return {
    status: row.status,
    billingCycle: row.billing_cycle,
    priceThb: row.price_thb,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    cancelledAt: row.cancelled_at,
    notifyTime: toHhMm(row.notify_time),
    daysLeft: daysLeft(row.expires_at, now),
  };
}

const diaryAddonRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (request, reply) => app.authenticate(request, reply));

  // ---- GET /diary-addon/status -------------------------------------------
  // Never plan-gated: a user who does NOT hold the add-on must still be able to
  // read this and see what buying it would give them (same reasoning as
  // GET /boosts serving free users a limit of 0).
  app.get('/diary-addon/status', async (request) => {
    const now = new Date();
    const { active, subscription } = await getAddonStatus(
      app.supabase,
      request.authUser!.userId,
      now,
    );
    return {
      name: DIARY_ADDON_DISPLAY_NAME,
      enabled: DIARY_ADDON_ENABLED,
      pricing: DIARY_ADDON_PRICE,
      currency: 'THB',
      // The perk the add-on bundles, so the plans page renders the number the
      // server actually enforces (a FLOOR — see effectiveMonthlyLimit) rather
      // than a literal in a component.
      giftBoxQuota: DIARY_ADDON_GIFT_BOX_QUOTA,
      active,
      subscription: subscription ? toDto(subscription, now) : null,
    };
  });

  // ---- POST /diary-addon/subscribe ---------------------------------------
  //
  // TODO(payment): gate behind a payment callback before production. As written
  // this grants a paid add-on for free to anyone who can call it. It exists so
  // the rest of the system (sweep, status, settings) is exercisable end to end,
  // and it is the seam the provider's webhook will call. The web app
  // deliberately does not call it — see the file header.
  /*
   * DISABLED — payment system not yet implemented.
   * Any authenticated user could self-upgrade for free.
   * Re-enable only after wiring to a verified payment webhook.
   */
  app.post('/diary-addon/subscribe', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    void request; // handler disabled below — the body is never read
    return reply.code(503).send({
      error: 'SERVICE_UNAVAILABLE',
      message: 'Plan upgrades are temporarily unavailable.',
      code: 'BILLING_NOT_READY',
    });
    // --- ORIGINAL HANDLER (kept for the payment-webhook rewire) --------------
    // const parsed = subscribeSchema.safeParse(request.body);
    // if (!parsed.success) {
    //   return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    // }
    // const now = new Date();
    // const subscription = await createSubscription(
    //   app.supabase,
    //   request.authUser!.userId,
    //   parsed.data.billingCycle,
    //   now,
    // );
    // return reply.send({ subscription: toDto(subscription, now) });
  });

  // ---- POST /diary-addon/cancel ------------------------------------------
  // Sets status='cancelled'; the row is NEVER deleted and access continues
  // until expires_at ("do not renew", not "cut me off now").
  app.post('/diary-addon/cancel', async (request, reply) => {
    const now = new Date();
    const cancelled = await cancelSubscription(app.supabase, request.authUser!.userId, now);
    if (!cancelled) {
      return reply
        .code(404)
        .send({ error: 'ยังไม่ได้สมัครหนูเก็บความทรงจำอยู่น้า', code: 'ADDON_NOT_ACTIVE' });
    }
    return reply.send({
      cancelledAt: cancelled.cancelled_at,
      // Surfaced so the UI can say "ใช้ได้ถึง …" rather than implying it stopped
      // the moment they tapped cancel.
      expiresAt: cancelled.expires_at,
    });
  });

  // ---- PATCH /diary-addon/notify-time ------------------------------------
  // Bangkok wall clock, 00:00–23:59. The hourly sweep reads this column.
  app.patch('/diary-addon/notify-time', async (request, reply) => {
    const parsed = notifyTimeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'เวลาต้องเป็นรูปแบบ HH:MM น้า', code: 'INVALID_NOTIFY_TIME' });
    }
    try {
      const notifyTime = await setNotifyTime(
        app.supabase,
        request.authUser!.userId,
        parsed.data.notifyTime,
      );
      if (notifyTime === null) {
        return reply
          .code(404)
          .send({ error: 'ยังไม่ได้สมัครหนูเก็บความทรงจำอยู่น้า', code: 'ADDON_NOT_ACTIVE' });
      }
      return reply.send({ notifyTime });
    } catch (err) {
      // Belt-and-braces: the service validates too, and the two must agree.
      if (err instanceof InvalidNotifyTimeError) {
        return reply
          .code(400)
          .send({ error: 'เวลาต้องเป็นรูปแบบ HH:MM น้า', code: 'INVALID_NOTIFY_TIME' });
      }
      throw err;
    }
  });
};

export default diaryAddonRoutes;
