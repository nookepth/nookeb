/**
 * /plans — the public price list, and the caller's own membership + quota state.
 *
 * Every number here is read from config/plans.ts. If a value in this file looks
 * like a literal, it is a bug.
 */

// BILLING SURFACE: POST /plans/change — apps/api/src/routes/plans.ts   (DISABLED, 503)
// BILLING SURFACE: POST /diary-addon/subscribe — apps/api/src/routes/diaryAddon.ts (DISABLED, 503)
//
// `changePlan()` (services/membership.service.ts) has exactly ONE caller in the
// repo — POST /plans/change below. There is no admin plan-mutation route:
// PATCH /admin/users/:id does not write users.plan (it only reads it for the
// user list). Verified by grep on 2026-08-02; re-check before re-enabling.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  MONTHLY_FEATURES,
  PLANS,
  REMINDER_INTERVAL_CHOICES,
  planSummary,
  type BillingCycle,
  type Plan,
} from '../config/plans';
import { periodResetAtIso } from '../config/billing-period';
import { changePlan, getMembership } from '../services/membership.service';
import { listMonthlyQuotas } from '../services/quota.service';
import { isActiveSubscriber } from '../services/diaryAddon.service';
import { ensurePlan } from '../middleware/planGuard';

const changePlanSchema = z.object({
  plan: z.enum(PLANS),
  cycle: z.enum(['monthly', 'yearly']).default('monthly'),
});

const plansRoutes: FastifyPluginAsync = async (app) => {
  // ---- GET /plans — public price list ------------------------------------
  // Unauthenticated on purpose: this is the pricing table, and the landing page
  // renders it without a session. It contains no user data.
  app.get('/plans', async () => ({
    plans: PLANS.map((p) => planSummary(p)),
    reminderIntervalChoices: REMINDER_INTERVAL_CHOICES,
    currency: 'THB',
  }));

  // ---- GET /plans/me — the caller's membership ---------------------------
  app.get('/plans/me', { preHandler: app.authenticate }, async (request) => {
    const membership = await getMembership(app.supabase, request.authUser!.userId);
    return {
      plan: membership.plan,
      summary: planSummary(membership.plan),
      referralCount: membership.referralCount,
      locker: {
        limitBytes: membership.lockerLimitBytes,
        usedBytes: membership.storageUsed,
      },
      subscription: membership.subscription,
    };
  });

  // ---- GET /plans/me/quotas — every monthly counter ----------------------
  // Read-only: deliberately does NOT create quota rows, so opening the account
  // page has no write side effects.
  app.get('/plans/me/quotas', { preHandler: app.authenticate }, async (request) => {
    const plan = await ensurePlan(request);
    // Add-ons can RAISE a limit (หนูเก็บความทรงจำ floors gift_boxes at 15), so
    // this display path must resolve them exactly like the enforcing path in
    // quotaCheck does — otherwise the account page and the 429 disagree.
    const diaryAddon = await isActiveSubscriber(app.supabase, request.authUser!.userId);
    const quotas = await listMonthlyQuotas(app.supabase, {
      userId: request.authUser!.userId,
      plan,
      features: MONTHLY_FEATURES,
      addons: { diaryAddon },
    });
    return {
      plan,
      resetAt: periodResetAtIso(),
      quotas: quotas.map((q) => ({
        feature: q.feature,
        limit: q.limit,
        used: q.used,
        remaining: q.unlimited ? null : q.remaining,
        unlimited: q.unlimited,
      })),
    };
  });

  // ---- POST /plans/change — move between plans ---------------------------
  //
  // NO PAYMENT IS TAKEN HERE. There is no billing provider in this codebase
  // (see the gap report): this endpoint records the plan change so the rest of
  // the system behaves correctly, and is the seam a payment webhook would call
  // once one exists. It is therefore admin/self-service only and rate-limited
  // tightly — it must never be the thing standing between a user and a paid
  // tier in production.
  //
  // It now answers 503 BILLING_NOT_READY unconditionally — see the block below
  // and "Temporarily Disabled Endpoints" in CLAUDE.md.
  /*
   * DISABLED — payment system not yet implemented.
   * Any authenticated user could self-upgrade for free.
   * Re-enable only after wiring to a verified payment webhook.
   */
  app.post('/plans/change', {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    void request; // handler disabled below — the body is never read
    return reply.code(503).send({
      error: 'SERVICE_UNAVAILABLE',
      message: 'Plan upgrades are temporarily unavailable.',
      code: 'BILLING_NOT_READY',
    });
    // --- ORIGINAL HANDLER (kept for the payment-webhook rewire) --------------
    // const parsed = changePlanSchema.safeParse(request.body);
    // if (!parsed.success) {
    //   return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    // }
    // const { plan, cycle } = parsed.data;
    //
    // if (plan !== 'free' && cycle === 'yearly' && planSummary(plan).pricing.yearly === null) {
    //   return reply.code(400).send({ error: 'แพ็กเกจนี้ไม่มีแบบรายปีน้า', code: 'CYCLE_UNAVAILABLE' });
    // }
    //
    // const result = await changePlan(
    //   app.supabase,
    //   request.authUser!.userId,
    //   plan as Plan,
    //   { cycle: cycle as BillingCycle },
    // );
    //
    // return reply.send({
    //   plan: result.plan,
    //   previousPlan: result.previousPlan,
    //   lockerLimitBytes: result.lockerLimitBytes,
    //   subscription: result.subscription,
    //   // Quota usage is intentionally preserved across a plan change — only the
    //   // limit moves (spec: recalculate limit, do not reset used).
    //   quotaUsageReset: false,
    // });
  });
};

export default plansRoutes;
