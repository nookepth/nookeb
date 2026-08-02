import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getLineQuotaSummary } from './line-quota.service';

/**
 * The LINE push allowance card (Feature 28).
 *
 * The whole value of this module is what it does when LINE is unreachable, so
 * that is what these tests are about. The cache is disabled throughout
 * (`cache: null`) — Redis has nothing to do with the properties being asserted,
 * and a test that opened a socket would be testing the wrong thing.
 *
 * THE CRITICAL CASE is the last assertion in the first block: a failure must
 * NOT render as "0 remaining". That is the single most alarming thing this card
 * could display, and it would come from the one condition where the product
 * knows nothing at all.
 */

/** A fetch that always rejects — no network. */
const deadFetch: typeof fetch = () => Promise.reject(new Error('ENOTFOUND api.line.me'));

/** A fetch that answers `status` with `body` for every call. */
function stubFetch(status: number, body: unknown): typeof fetch {
  return () =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response);
}

/** Different answers per endpoint, keyed by a substring of the path. */
function routedFetch(routes: Record<string, unknown>): typeof fetch {
  return (input) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return Promise.reject(new Error(`unexpected URL ${url}`));
    return Promise.resolve({ ok: true, status: 200, json: async () => routes[key] } as Response);
  };
}

const NO_CACHE = { cache: null } as const;

describe('getLineQuotaSummary — safe default on failure', () => {
  it('returns the unknown summary on a network error, and never throws', async () => {
    const s = await getLineQuotaSummary('token', { ...NO_CACHE, fetchImpl: deadFetch });
    assert.equal(s.type, 'none');
    assert.equal(s.limit, null);
    assert.equal(s.consumed, 0);
    // THE POINT: null, not 0. "We do not know" must never render as
    // "the allowance is exhausted".
    assert.equal(s.remaining, null);
    assert.ok(!Number.isNaN(new Date(s.fetchedAt).getTime()));
  });

  it('returns the unknown summary on a 401 (bad or expired channel token)', async () => {
    const s = await getLineQuotaSummary('bad-token', {
      ...NO_CACHE,
      fetchImpl: stubFetch(401, { message: 'Authentication failed' }),
    });
    assert.equal(s.type, 'none');
    assert.equal(s.remaining, null);
  });

  it('returns the unknown summary when totalUsage is not a number', async () => {
    // A shape change at LINE's end must degrade to "unknown", not to a NaN that
    // renders as a blank number and reads as a real, empty allowance.
    const s = await getLineQuotaSummary('token', {
      ...NO_CACHE,
      fetchImpl: routedFetch({
        '/quota/consumption': { totalUsage: 'lots' },
        '/message/quota': { type: 'limited', value: 500 },
      }),
    });
    assert.equal(s.type, 'none');
  });
});

describe('getLineQuotaSummary — successful reads', () => {
  it('reports a real ceiling as limited, with remaining computed', async () => {
    const s = await getLineQuotaSummary('token', {
      ...NO_CACHE,
      fetchImpl: routedFetch({
        '/quota/consumption': { totalUsage: 200 },
        '/message/quota': { type: 'limited', value: 500 },
      }),
    });
    assert.equal(s.type, 'limited');
    assert.equal(s.limit, 500);
    assert.equal(s.consumed, 200);
    assert.equal(s.remaining, 300);
  });

  it('clamps remaining at 0 — LINE can report consumption past the ceiling', async () => {
    const s = await getLineQuotaSummary('token', {
      ...NO_CACHE,
      fetchImpl: routedFetch({
        '/quota/consumption': { totalUsage: 700 },
        '/message/quota': { type: 'limited', value: 500 },
      }),
    });
    assert.equal(s.remaining, 0);
  });

  it("renames LINE's type 'none' to 'unlimited' — it means NO CAP, not no data", async () => {
    // The rename is the point: 'none' reads as "no information" in an admin
    // panel when it actually means the opposite, and this module reserves
    // 'none' for the genuine no-information case.
    const s = await getLineQuotaSummary('token', {
      ...NO_CACHE,
      fetchImpl: routedFetch({
        '/quota/consumption': { totalUsage: 42 },
        '/message/quota': { type: 'none' },
      }),
    });
    assert.equal(s.type, 'unlimited');
    assert.equal(s.limit, null);
    assert.equal(s.remaining, null);
    assert.equal(s.consumed, 42);
  });

  it('degrades a limited OA with no readable ceiling to unlimited, not to a fake number', async () => {
    const s = await getLineQuotaSummary('token', {
      ...NO_CACHE,
      fetchImpl: routedFetch({
        '/quota/consumption': { totalUsage: 10 },
        '/message/quota': { type: 'limited' },
      }),
    });
    assert.equal(s.type, 'unlimited');
    assert.equal(s.limit, null);
  });
});

describe('getLineQuotaSummary — caching', () => {
  it('serves a cached summary without calling LINE', async () => {
    const cached = JSON.stringify({
      type: 'limited',
      limit: 500,
      consumed: 1,
      remaining: 499,
      fetchedAt: '2026-08-02T00:00:00.000Z',
    });
    const s = await getLineQuotaSummary('token', {
      // A fetch that would reject proves the cache short-circuited.
      fetchImpl: deadFetch,
      cache: { get: async () => cached, set: async () => {} },
    });
    assert.equal(s.consumed, 1);
    assert.equal(s.remaining, 499);
  });

  it('does NOT cache a failure — one blip must not become five minutes of blank', async () => {
    const sets: string[] = [];
    await getLineQuotaSummary('token', {
      fetchImpl: deadFetch,
      cache: {
        get: async () => null,
        set: async (_k, v) => {
          sets.push(v);
        },
      },
    });
    assert.deepEqual(sets, []);
  });

  it('falls through to LINE when the cache itself is down', async () => {
    const s = await getLineQuotaSummary('token', {
      fetchImpl: routedFetch({
        '/quota/consumption': { totalUsage: 5 },
        '/message/quota': { type: 'limited', value: 100 },
      }),
      cache: {
        get: () => Promise.reject(new Error('ECONNREFUSED')),
        set: () => Promise.reject(new Error('ECONNREFUSED')),
      },
    });
    assert.equal(s.type, 'limited');
    assert.equal(s.remaining, 95);
  });
});
