/**
 * Quota enforcement middleware.
 *
 * The exported factory makes the SCOPE explicit at every call site, which is
 * the point — a group-file upload and a task create are both "one unit" but
 * they are counted in different buckets, and reading the route must tell you
 * which:
 *
 *   app.post('/tasks',        { preHandler: [app.authenticate, quotaCheck('tasks')] })
 *   app.post('/groups/:id/files', {
 *     preHandler: [app.authenticate, quotaCheck('group_files', groupScope('id'))],
 *   })
 *
 * Middleware order is ALWAYS: authenticate → planGuard → quotaCheck → handler.
 *
 * RESERVE-then-SETTLE. quotaCheck does not merely peek; it reserves the unit
 * atomically (see services/quota.service.ts for why a read-only pre-check is
 * unsafe). The reservation is released automatically when the handler answers
 * 4xx/5xx, so a request rejected AFTER the quota hook — a bad file type, a
 * failed upstream — never burns a unit. A handler that fails silently and still
 * returns 2xx keeps the unit, which is the correct direction to be wrong in.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import type { MonthlyFeature } from '../config/plans';
import { consumeQuota, quotaExceededPayload, releaseQuota } from '../services/quota.service';
import { ensurePlan } from './planGuard';

/** A reservation held for the duration of one request. */
interface QuotaReservation {
  feature: MonthlyFeature;
  scopeId: string;
  amount: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Reservations taken by quotaCheck on this request. */
    quotaReservations?: QuotaReservation[];
    /** Set when a handler wants to keep a reservation despite a 4xx (rare). */
    quotaKeepOnError?: boolean;
  }
}

/**
 * Resolves the scope key for a quota. Returning null means "user-global".
 * Async so a resolver may look the group up from a body field or the DB.
 */
export type QuotaScopeResolver = (
  request: FastifyRequest,
) => string | null | Promise<string | null>;

/** How many units this request spends. Defaults to 1. */
export type QuotaAmountResolver = (request: FastifyRequest) => number | Promise<number>;

export interface QuotaCheckOptions {
  amount?: number | QuotaAmountResolver;
  /**
   * Release the reservation automatically if the response is >= 400.
   * Default true. Turn it off only where the unit is spent by a side effect the
   * handler already committed before failing.
   */
  releaseOnError?: boolean;
}

// --- Common scope resolvers -------------------------------------------------

/** Scope a quota to a LINE group id read from a route param. */
export function groupScope(param = 'groupId'): QuotaScopeResolver {
  return (request) => {
    const params = request.params as Record<string, string | undefined>;
    return params?.[param] ?? null;
  };
}

/** Scope a quota to a LINE group id read from a body field. */
export function groupScopeFromBody(field = 'groupId'): QuotaScopeResolver {
  return (request) => {
    const body = request.body as Record<string, unknown> | undefined;
    const v = body?.[field];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
}

/** Explicitly user-global — spelled out at call sites for readability. */
export const userScope: QuotaScopeResolver = () => null;

// --- The factory ------------------------------------------------------------

/**
 * Build a preHandler that reserves one (or `amount`) unit of `feature`.
 *
 * On rejection it answers **429** with the structured body the spec mandates:
 *   { error, feature, limit, used, reset_at }
 *
 * 429 rather than 403: the request is well-formed and the caller is
 * authorised — they have simply run out for this period, and the response
 * carries the time it becomes valid again. 403 is reserved for plan gating
 * (planGuard), so the two failures stay distinguishable by status alone.
 */
export function quotaCheck(
  feature: MonthlyFeature,
  scope: QuotaScopeResolver = userScope,
  options: QuotaCheckOptions = {},
): preHandlerHookHandler {
  return async function quotaCheckHandler(request: FastifyRequest, reply: FastifyReply) {
    const auth = request.authUser;
    if (!auth) {
      throw new Error('quotaCheck: authenticate must run before any quota check');
    }

    const plan = await ensurePlan(request);
    const scopeId = (await scope(request)) ?? '';

    const amount =
      typeof options.amount === 'function'
        ? await options.amount(request)
        : (options.amount ?? 1);

    // A zero/negative amount is a caller bug, not a free pass — but failing the
    // whole request over it would be worse than counting nothing.
    if (!Number.isFinite(amount) || amount < 0) {
      request.log.warn({ feature, amount }, 'quotaCheck: invalid amount, treating as 1');
    }
    const units = Number.isFinite(amount) && amount >= 0 ? Math.floor(amount) : 1;

    const decision = await consumeQuota(request.server.supabase, {
      userId: auth.userId,
      feature,
      plan,
      scopeId,
      amount: units,
    });

    if (!decision.allowed) {
      await reply.code(429).send(quotaExceededPayload(decision));
      return;
    }

    if (units > 0) {
      request.quotaReservations ??= [];
      request.quotaReservations.push({ feature, scopeId, amount: units });
    }
    if (options.releaseOnError === false) request.quotaKeepOnError = true;
  };
}

/**
 * Release every reservation held by a request. Exposed so a handler can give
 * units back explicitly when it decides mid-flight that the action will not
 * happen but still wants to answer 2xx (e.g. "nothing to do").
 */
export async function releaseRequestQuotas(request: FastifyRequest): Promise<void> {
  const held = request.quotaReservations;
  if (!held || held.length === 0) return;
  request.quotaReservations = [];

  const auth = request.authUser;
  if (!auth) return;

  for (const r of held) {
    try {
      await releaseQuota(request.server.supabase, {
        userId: auth.userId,
        feature: r.feature,
        scopeId: r.scopeId,
        amount: r.amount,
      });
    } catch (err) {
      // A leaked reservation costs the user one unit until the monthly reset.
      // Loud, but never fatal — the request has already failed.
      request.log.error({ err, feature: r.feature }, 'quota: failed to release reservation');
    }
  }
}

/**
 * Registers the auto-release hook. Must be registered ONCE on the root
 * instance (index.ts) — it is a no-op for requests that took no reservation.
 *
 * onResponse, not onError: a handler can answer 4xx by returning a reply
 * without throwing, and onError would miss exactly those cases.
 */
export default fp(async (app: FastifyInstance) => {
  app.decorateRequest('quotaReservations', undefined);
  app.decorateRequest('quotaKeepOnError', false);

  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode < 400) return;
    if (request.quotaKeepOnError) return;
    await releaseRequestQuotas(request);
  });
});
