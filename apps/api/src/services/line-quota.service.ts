/**
 * LINE push allowance tracker — the number nothing else in the product can see.
 *
 * THE PROBLEM. LINE's push allowance is metered per calendar month and, once
 * spent, pushes FAIL SILENTLY (a 429 whose body is the only thing that
 * distinguishes it from an ordinary rate limit). Every quota surface the admin
 * page already has is the product's OWN accounting: user_quotas' per-user §4a
 * allowance, /admin/notifications' burndown. None of them knows what LINE
 * thinks. A deployment can be perfectly within its own limits and still be
 * three days from a silent messaging outage, and until now the only way to
 * find out was to open the LINE console.
 *
 * ── Two endpoints, because LINE splits the answer ──────────────────────────
 *
 *   GET /v2/bot/message/quota              → { type, value? }
 *   GET /v2/bot/message/quota/consumption  → { totalUsage }
 *
 * `type` is 'limited' (a real ceiling in `value`) or 'none'. 'none' means the
 * OA has NO monthly cap — which is what a verified/premium plan on an unlimited
 * push tier reports. This module normalises that to the third `type` value
 * 'unlimited' rather than passing 'none' through, because 'none' is a word that
 * reads as "no quota information" in an admin panel when it actually means the
 * opposite. The genuine no-information case keeps the name 'none'.
 *
 * So the returned `type` means:
 *   'limited'    a real ceiling; limit and remaining are numbers
 *   'unlimited'  LINE reports no cap; limit and remaining are null
 *   'none'       we could not find out (network, 4xx, bad token, unparseable)
 *
 * `limit: null` and `remaining: null` are used for BOTH 'unlimited' and 'none'
 * on purpose: neither has a number, and inventing 0 for the failure case would
 * render as "allowance exhausted" — the single most alarming thing this card
 * could say, from the one condition where it knows nothing.
 *
 * ── Fail soft, always ──────────────────────────────────────────────────────
 *
 * Never throws. Any failure returns the zero summary above. This is an ops
 * panel and it is read exactly when things are unhealthy; a card that renders
 * "—" is a working page reporting missing data, and the /admin/* fail-soft
 * contract (see routes/admin-ops.ts's header) applies to it like everything
 * else.
 *
 * ── Caching ────────────────────────────────────────────────────────────────
 *
 * Two LINE round trips per read, and the page polls. 300 s in Redis under
 * `line:quota:summary` — the number moves by single-digit messages per minute
 * at this product's volume, so five-minute granularity is more than the
 * decision it informs ("do we need to raise the plan this week?") requires.
 * Cached only on SUCCESS: caching a failure would extend one blip into five
 * minutes of a blank card, the same rule getPushEnabled follows.
 */

import type { Redis } from 'ioredis';
import { createRedis } from '../plugins/redis';

const LINE_API = 'https://api.line.me/v2/bot';
const CACHE_KEY = 'line:quota:summary';
const CACHE_TTL_SECONDS = 300;
const FETCH_TIMEOUT_MS = 6_000;

export interface LineQuotaSummary {
  type: 'none' | 'limited' | 'unlimited';
  limit: number | null;
  consumed: number;
  remaining: number | null;
  fetchedAt: string;
}

/**
 * Injectable dependencies, defaulted to the real ones.
 *
 * The whole value of this module is what it does when the network is gone, and
 * the only way to prove that is to hand it a fetch that rejects. An optional
 * deps bag keeps the required one-argument signature intact while making the
 * failure path testable without opening a socket — the same reasoning as
 * push-flag.service's PushFlagCache seam.
 */
export interface LineQuotaDeps {
  fetchImpl?: typeof fetch;
  cache?: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttlSeconds: number): Promise<void>;
  } | null;
}

let redisClient: Redis | null = null;

function defaultCache(): NonNullable<LineQuotaDeps['cache']> {
  if (!redisClient) redisClient = createRedis();
  const client = redisClient;
  return {
    get: (key) => client.get(key),
    set: async (key, value, ttl) => {
      await client.set(key, value, 'EX', ttl);
    },
  };
}

/** The answer when we do not have one. Never 0-with-a-limit — see the header. */
function unknownSummary(): LineQuotaSummary {
  return {
    type: 'none',
    limit: null,
    consumed: 0,
    remaining: null,
    fetchedAt: new Date().toISOString(),
  };
}

async function getJson(
  fetchImpl: typeof fetch,
  path: string,
  accessToken: string,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(`${LINE_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`LINE ${path} responded ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Current push allowance and consumption. NEVER THROWS — see the header.
 *
 * The two calls run in PARALLEL and are awaited together: they are independent
 * reads and one failing makes the whole summary unusable anyway (a consumption
 * figure with no ceiling answers nothing), so there is no partial result worth
 * assembling.
 */
export async function getLineQuotaSummary(
  accessToken: string,
  deps: LineQuotaDeps = {},
): Promise<LineQuotaSummary> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  // `null` disables caching entirely (tests); `undefined` means "use Redis".
  const cache = deps.cache === null ? null : (deps.cache ?? safeDefaultCache());

  if (cache) {
    try {
      const cached = await cache.get(CACHE_KEY);
      if (cached !== null) return JSON.parse(cached) as LineQuotaSummary;
    } catch (err) {
      // A dead cache says nothing about the allowance — fall through to LINE
      // rather than returning the unknown summary early.
      console.warn('[line-quota] cache read failed, falling through to LINE:', err);
    }
  }

  let summary: LineQuotaSummary;
  try {
    const [quota, consumption] = await Promise.all([
      getJson(fetchImpl, '/message/quota', accessToken),
      getJson(fetchImpl, '/message/quota/consumption', accessToken),
    ]);

    const consumed = Number(consumption.totalUsage ?? 0);
    // A NaN here would propagate into `remaining` and render as a blank number
    // rather than as "unknown", so it is treated as the failure it is.
    if (!Number.isFinite(consumed)) throw new Error('LINE returned a non-numeric totalUsage');

    // 'limited' is the only type that carries a ceiling. `value` is the
    // documented field; `totalUsage` is accepted as a fallback because the
    // quota endpoint has carried both names across API revisions and a missing
    // ceiling would otherwise silently degrade a limited OA to 'unlimited' —
    // the wrong direction to be wrong in for a card about running out.
    const rawLimit = Number(quota.value ?? quota.totalUsage ?? NaN);
    if (quota.type === 'limited' && Number.isFinite(rawLimit)) {
      summary = {
        type: 'limited',
        limit: rawLimit,
        consumed,
        // Clamped at 0: LINE can report consumption at or past the ceiling, and
        // a negative "remaining" is not a thing anyone should have to read.
        remaining: Math.max(0, rawLimit - consumed),
        fetchedAt: new Date().toISOString(),
      };
    } else {
      // 'none' from LINE means NO CAP. Renamed here — see the header.
      summary = {
        type: 'unlimited',
        limit: null,
        consumed,
        remaining: null,
        fetchedAt: new Date().toISOString(),
      };
    }
  } catch (err) {
    console.warn('[line-quota] read failed — reporting unknown:', err);
    return unknownSummary();
  }

  if (cache) {
    try {
      await cache.set(CACHE_KEY, JSON.stringify(summary), CACHE_TTL_SECONDS);
    } catch (err) {
      console.warn('[line-quota] cache write failed (harmless, next read re-derives):', err);
    }
  }
  return summary;
}

/**
 * The Redis-backed cache, or none at all.
 *
 * createRedis() THROWS on a malformed REDIS_URL, and that must not be the thing
 * that takes down a card whose entire contract is to degrade quietly.
 */
function safeDefaultCache(): LineQuotaDeps['cache'] {
  try {
    return defaultCache();
  } catch (err) {
    console.warn('[line-quota] no cache available, reading LINE uncached:', err);
    return null;
  }
}

/** Release the lazy connection. Mirrors closePushFlag(). */
export async function closeLineQuota(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
