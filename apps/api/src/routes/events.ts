import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { isClientTrackableEvent, logEvent, toPlanTier } from '../services/events.service';

/**
 * Client event ingestion (Task 2). The ONE endpoint a browser/LIFF client uses
 * to record product-analytics events — the single server-side call site behind
 * the web `trackEvent()` utility. The client NEVER writes usage_events directly
 * (the privacy/no-PII rule from migration 029 is preserved): this route
 *
 *   (a) validates event_name against the server-side CLIENT_TRACKABLE_EVENTS
 *       whitelist and rejects anything else (so a client can't forge a
 *       server-authoritative event like upload_done or web_login),
 *   (b) sanitises the payload down to short scalars — numbers, booleans, and
 *       slug-shaped strings only — so no free text / file names / PII can ride
 *       in through metadata,
 *   (c) derives plan_tier SERVER-side from users.plan (never trusts the client),
 *   (d) hands off to the same best-effort logEvent() every server call site uses.
 *
 * Auth: same session cookie as the rest of the app (works for both the
 * dashboard and the LIFF task pages — same-origin /api-proxy).
 */

const SLUG = /^[\w.-]{1,40}$/;
const MAX_PAYLOAD_KEYS = 12;

const bodySchema = z.object({
  eventName: z.string().min(1).max(64),
  payload: z.record(z.unknown()).optional(),
  sessionId: z.string().uuid().optional(),
  // small origin hint; anything unexpected is dropped rather than rejected.
  entryChannel: z.string().regex(/^[\w-]{1,20}$/).optional(),
});

/**
 * Keep only privacy-safe scalars: numbers, booleans, and short slug strings.
 * Free text, long strings, nested objects, and arrays are dropped — never
 * stored. Caps the key count so a client can't bloat a row.
 */
function sanitizePayload(raw: Record<string, unknown> | undefined): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  if (!raw) return out;
  let n = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (n >= MAX_PAYLOAD_KEYS) break;
    if (!SLUG.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
      n++;
    } else if (typeof value === 'boolean') {
      out[key] = value;
      n++;
    } else if (typeof value === 'string' && SLUG.test(value)) {
      out[key] = value;
      n++;
    }
    // everything else (long strings, objects, arrays, null) is intentionally dropped
  }
  return out;
}

const eventsRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/events/track', { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid event', code: 'INVALID_EVENT' });
    }

    const { eventName, payload, sessionId, entryChannel } = parsed.data;
    if (!isClientTrackableEvent(eventName)) {
      // Unknown or server-authoritative name — refuse rather than store it.
      return reply.code(400).send({ error: 'unknown event', code: 'UNKNOWN_EVENT' });
    }

    const userId = request.authUser!.userId;

    // plan_tier is derived server-side; a failed lookup just leaves it null.
    let planTier = null as ReturnType<typeof toPlanTier>;
    try {
      const { data } = await app.supabase.from('users').select('plan').eq('id', userId).single();
      planTier = toPlanTier((data as { plan?: string } | null)?.plan);
    } catch {
      // best-effort — log the event without the plan dimension
    }

    void logEvent(app.supabase, {
      eventType: eventName,
      userId,
      source: 'web',
      metadata: sanitizePayload(payload),
      sessionId: sessionId ?? null,
      planTier,
      entryChannel: entryChannel ?? null,
    });

    return { success: true };
  });
};

export default eventsRoutes;
