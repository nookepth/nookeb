/**
 * /plans — the public price list, and the caller's own membership + quota state.
 *
 * Every number here is read from config/plans.ts. If a value in this file looks
 * like a literal, it is a bug.
 */

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
    const quotas = await listMonthlyQuotas(app.supabase, {
      userId: request.authUser!.userId,
      plan,
      features: MONTHLY_FEATURES,
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
  app.post('/plans/change', {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const parsed = changePlanSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }
    const { plan, cycle } = parsed.data;

    if (plan !== 'free' && cycle === 'yearly' && planSummary(plan).pricing.yearly === null) {
      return reply.code(400).send({ error: 'แพ็กเกจนี้ไม่มีแบบรายปีน้า', code: 'CYCLE_UNAVAILABLE' });
    }

    const result = await changePlan(
      app.supabase,
      request.authUser!.userId,
      plan as Plan,
      { cycle: cycle as BillingCycle },
    );

    return reply.send({
      plan: result.plan,
      previousPlan: result.previousPlan,
      lockerLimitBytes: result.lockerLimitBytes,
      subscription: result.subscription,
      // Quota usage is intentionally preserved across a plan change — only the
      // limit moves (spec: recalculate limit, do not reset used).
      quotaUsageReset: false,
    });
  });
};

export default plansRoutes;
