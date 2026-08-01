/**
 * Plan feature-flag guard — the boolean half of the membership system.
 *
 * Route middleware order is ALWAYS: authenticate → planGuard → quotaCheck →
 * handler. planGuard runs before quotaCheck on purpose: a free user hitting a
 * premium-only route should be told to upgrade, not told their quota is fine.
 *
 * Every gate answers 403 with a machine-readable `code` plus Thai copy, matching
 * the vault's existing convention (403 + code, never 401 — see routes/vault.ts).
 */

import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import {
  hasFeature,
  normalizePlan,
  REMINDER_POLICY,
  validateReminderSelection,
  type Plan,
  type PlanFeature,
} from '../config/plans';
import { resolveUserPlan } from '../services/quota.service';

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved once per request by planGuard/quotaCheck and reused downstream. */
    plan?: Plan;
    planReferralCount?: number;
  }
}

/** Thai copy per gated feature — one place, so the wording stays consistent. */
const UPGRADE_COPY: Record<PlanFeature, string> = {
  export_task_summary: 'ดาวน์โหลดสรุปงานเป็น Excel ใช้ได้กับแพ็กเกจ Pro ขึ้นไปน้า',
  google_sheets: 'เชื่อม Google Sheets ใช้ได้กับแพ็กเกจ Premium น้า',
  performance_report: 'รายงานผลการทำงานรายบุคคล ใช้ได้กับแพ็กเกจ Premium น้า',
  notify_only_pending: 'เตือนเฉพาะคนที่ยังไม่ส่งงาน ใช้ได้กับแพ็กเกจ Pro ขึ้นไปน้า',
  group_boost: 'บูธกลุ่ม ใช้ได้กับแพ็กเกจ Pro ขึ้นไปน้า',
  onboarding_call: 'นัดตั้งค่าเริ่มต้นแบบตัวต่อตัว ใช้ได้กับแพ็กเกจ Premium น้า',
  referral_storage_bonus: 'โบนัสพื้นที่จากการชวนเพื่อน ใช้ได้กับแพ็กเกจฟรีน้า',
  daily_diary_reminder: 'เตือนเขียนไดอารี่ทุกวัน ใช้ได้กับแพ็กเกจ Pro ขึ้นไปน้า',
};

/** The minimum plan that unlocks a feature — for the `required_plan` hint. */
function minimumPlanFor(feature: PlanFeature): Plan | null {
  const order: Plan[] = ['free', 'pro', 'premium'];
  return order.find((p) => hasFeature(p, feature)) ?? null;
}

/**
 * Resolve and cache the caller's plan on the request. Safe to call from several
 * hooks in one request — the second call is free.
 *
 * Requires `authenticate` to have run; a missing authUser is a wiring bug in the
 * route's preHandler order, so it throws rather than silently allowing.
 */
export async function ensurePlan(request: FastifyRequest): Promise<Plan> {
  if (request.plan) return request.plan;
  const auth = request.authUser;
  if (!auth) {
    throw new Error('planGuard: authenticate must run before any plan check');
  }
  const ctx = await resolveUserPlan(request.server.supabase, auth.userId);
  request.plan = ctx.plan;
  request.planReferralCount = ctx.referralCount;
  return ctx.plan;
}

/**
 * Guard a route behind a plan feature flag.
 *
 *   app.get('/tasks/export', {
 *     preHandler: [app.authenticate, planGuard('export_task_summary')],
 *   }, handler);
 */
export function planGuard(feature: PlanFeature): preHandlerHookHandler {
  return async function planGuardHandler(request: FastifyRequest, reply: FastifyReply) {
    const plan = await ensurePlan(request);
    if (hasFeature(plan, feature)) return;

    await reply.code(403).send({
      error: UPGRADE_COPY[feature],
      code: 'PLAN_UPGRADE_REQUIRED',
      feature,
      current_plan: plan,
      required_plan: minimumPlanFor(feature),
    });
  };
}

/**
 * Non-throwing check for handlers that must BRANCH on a feature rather than
 * reject (e.g. the Sheets worker skipping a mirror for a downgraded user, or a
 * reminder job choosing between "notify everyone" and "notify non-submitters").
 */
export function planAllows(plan: string | null | undefined, feature: PlanFeature): boolean {
  return hasFeature(normalizePlan(plan), feature);
}

// ---------------------------------------------------------------------------
// Reminder-interval selection (§4b) — a plan limit on a BODY FIELD, so it
// cannot be a route-level preHandler; handlers call this after parsing.
// ---------------------------------------------------------------------------

export interface ReminderConfigResult {
  ok: true;
  /** Normalised hours-before-deadline, [] when the deadline fallback applies. */
  intervals: number[];
  notifyOnlyPending: boolean;
}
export interface ReminderConfigRejection {
  ok: false;
  status: number;
  body: Record<string, unknown>;
}

/**
 * Validate a task's reminder configuration against the caller's plan.
 *
 * Two independent gates:
 *  - §4b the checkbox COUNT (free 1 / pro 2 / premium 4), and every value must
 *    be one of the five allowed intervals;
 *  - §4c the "notify only non-submitters" toggle, pro and above.
 *
 * Server-side by construction: the client's own limit is a convenience, and a
 * hand-rolled request that posts five intervals is rejected here.
 */
export function resolveReminderConfig(args: {
  plan: Plan;
  intervals?: readonly number[] | null;
  notifyOnlyPending?: boolean | null;
}): ReminderConfigResult | ReminderConfigRejection {
  const policy = REMINDER_POLICY[args.plan];

  const selection = validateReminderSelection(args.plan, args.intervals);
  if (!selection.ok) {
    return {
      ok: false,
      status: selection.code === 'INVALID_INTERVAL' ? 400 : 403,
      body:
        selection.code === 'INVALID_INTERVAL'
          ? {
              error: 'ช่วงเวลาเตือนไม่ถูกต้องน้า',
              code: 'INVALID_REMINDER_INTERVAL',
              allowed: [3, 6, 24, 48, 72],
            }
          : {
              error: `แพ็กเกจนี้เลือกเวลาเตือนได้สูงสุด ${selection.max} ช่วงน้า`,
              code: 'REMINDER_INTERVAL_LIMIT',
              limit: selection.max,
              current_plan: args.plan,
            },
    };
  }

  const wantsOnlyPending = args.notifyOnlyPending === true;
  if (wantsOnlyPending && !policy.notifyOnlyPending) {
    return {
      ok: false,
      status: 403,
      body: {
        error: UPGRADE_COPY.notify_only_pending,
        code: 'PLAN_UPGRADE_REQUIRED',
        feature: 'notify_only_pending',
        current_plan: args.plan,
        required_plan: minimumPlanFor('notify_only_pending'),
      },
    };
  }

  return { ok: true, intervals: selection.intervals, notifyOnlyPending: wantsOnlyPending };
}
