import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  __setPushFlagCacheForTests,
  getPushEnabled,
  invalidatePushEnabledCache,
  readPushEnabledUncached,
  setPushEnabled,
  type PushFlagCache,
} from './push-flag.service';

/**
 * The push kill switch (migration 059), and the ONE property that makes it safe
 * to put in front of every LINE push in the product: it FAILS OPEN.
 *
 * Every other TIER 2 path fails closed — a failed admin write must not be
 * reported as a success. This one is the deliberate inverse. A Supabase blip or
 * a dead Redis that silently muted every task reminder would look exactly like a
 * healthy product until users noticed nobody had been reminded, and there is no
 * alert for "messages that were never sent". So an outage must never be able to
 * mute the product; only a human flipping the switch may.
 *
 * The tests below therefore hammer the failure paths, not the happy one.
 */

// ---------------------------------------------------------------------------
// Fakes. The cache is swapped through the module's test seam; the DB is passed
// in per call, so neither test ever opens a socket.
// ---------------------------------------------------------------------------

interface CacheLog {
  gets: string[];
  sets: { key: string; value: string; ttl: number }[];
  dels: string[];
}

/** A working in-memory cache that records every operation. */
function recordingCache(seed?: Record<string, string>): { cache: PushFlagCache; log: CacheLog } {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  const log: CacheLog = { gets: [], sets: [], dels: [] };
  return {
    log,
    cache: {
      get: async (key) => {
        log.gets.push(key);
        return store.get(key) ?? null;
      },
      set: async (key, value, ttl) => {
        log.sets.push({ key, value, ttl });
        store.set(key, value);
      },
      del: async (key) => {
        log.dels.push(key);
        store.delete(key);
      },
    },
  };
}

/** A cache whose every operation throws — a Redis outage. */
const deadCache: PushFlagCache = {
  get: () => Promise.reject(new Error('ECONNREFUSED')),
  set: () => Promise.reject(new Error('ECONNREFUSED')),
  del: () => Promise.reject(new Error('ECONNREFUSED')),
};

/**
 * Minimal Supabase stand-in covering the two shapes this module uses:
 *   .from(t).select(c).eq(k, v).maybeSingle()
 *   .from(t).upsert(row, opts)  /  .from(t).insert(row)
 */
function fakeDb(opts: {
  /** Value returned from system_settings, or 'throw' / 'missing'. */
  value: unknown | 'throw' | 'missing';
  /** Force the audit insert to fail. */
  auditFails?: boolean;
  writes?: Record<string, unknown>[];
  audits?: Record<string, unknown>[];
}): SupabaseClient {
  const from = (table: string): Record<string, unknown> => {
    const builder: Record<string, unknown> = {};
    const passthrough = (name: string): void => {
      builder[name] = () => builder;
    };
    ['select', 'eq'].forEach(passthrough);

    builder.maybeSingle = async () => {
      if (opts.value === 'throw') return { data: null, error: { message: 'boom' } };
      if (opts.value === 'missing') return { data: null, error: null };
      return { data: { value: opts.value }, error: null };
    };
    builder.upsert = async (row: Record<string, unknown>) => {
      opts.writes?.push({ table, ...row });
      return { data: null, error: null };
    };
    builder.insert = async (row: Record<string, unknown>) => {
      opts.audits?.push({ table, ...row });
      return opts.auditFails ? { data: null, error: { message: 'audit down' } } : { data: null, error: null };
    };
    return builder;
  };
  return { from } as unknown as SupabaseClient;
}

afterEach(() => {
  __setPushFlagCacheForTests(null);
});

describe('getPushEnabled — fail open', () => {
  it('returns true when Redis is down AND the DB read fails', async () => {
    // The nightmare case: both dependencies gone. The product keeps talking.
    __setPushFlagCacheForTests(deadCache);
    const enabled = await getPushEnabled(fakeDb({ value: 'throw' }));
    assert.equal(enabled, true);
  });

  it('returns true when only the DB read fails', async () => {
    const { cache } = recordingCache();
    __setPushFlagCacheForTests(cache);
    assert.equal(await getPushEnabled(fakeDb({ value: 'throw' })), true);
  });

  it('does NOT cache a fail-open guess', async () => {
    // Caching the guess would turn one blip into a full minute of pretending we
    // know the answer, and would outlive the outage that caused it.
    const { cache, log } = recordingCache();
    __setPushFlagCacheForTests(cache);
    await getPushEnabled(fakeDb({ value: 'throw' }));
    assert.deepEqual(log.sets, []);
  });

  it('falls through to the DB when only Redis is down, and still reads false', async () => {
    // A dead cache must not be mistaken for "no setting" — the switch still
    // works, it is just uncached. This is the case that proves fail-open is
    // about ERRORS, not about ignoring the admin's decision.
    __setPushFlagCacheForTests(deadCache);
    assert.equal(await getPushEnabled(fakeDb({ value: false })), false);
  });

  it('returns true when the settings row is missing entirely (migration 059 unapplied)', async () => {
    const { cache } = recordingCache();
    __setPushFlagCacheForTests(cache);
    assert.equal(await getPushEnabled(fakeDb({ value: 'missing' })), true);
  });

  it('treats any non-false value as ON, so a malformed write cannot mute the product', async () => {
    const { cache } = recordingCache();
    for (const junk of [null, 'false', 0, {}, []]) {
      __setPushFlagCacheForTests(cache);
      await invalidatePushEnabledCache();
      assert.equal(await getPushEnabled(fakeDb({ value: junk })), true, `value ${JSON.stringify(junk)}`);
    }
  });
});

describe('getPushEnabled — caching', () => {
  it('serves a cached "off" without touching the DB', async () => {
    const { cache } = recordingCache({ 'settings:push_enabled': '0' });
    __setPushFlagCacheForTests(cache);
    // A DB that would throw if consulted proves the cache short-circuited.
    assert.equal(await getPushEnabled(fakeDb({ value: 'throw' })), false);
  });

  it('caches a real read under settings:push_enabled with a 300s TTL', async () => {
    const { cache, log } = recordingCache();
    __setPushFlagCacheForTests(cache);
    await getPushEnabled(fakeDb({ value: false }));
    assert.deepEqual(log.sets, [{ key: 'settings:push_enabled', value: '0', ttl: 300 }]);
  });
});

describe('setPushEnabled', () => {
  it('invalidates the Redis cache so the next read cannot serve the old value', async () => {
    // Without this, an admin's flip would take up to 60s to be visible in the
    // API and the worker — the exact minute during which they are watching to
    // see whether it worked.
    const { cache, log } = recordingCache({ 'settings:push_enabled': '1' });
    __setPushFlagCacheForTests(cache);

    const writes: Record<string, unknown>[] = [];
    await setPushEnabled(false, fakeDb({ value: true, writes, audits: [] }), 'Uadmin');

    assert.deepEqual(log.dels, ['settings:push_enabled']);
    // And the invalidation is a DELETE, not an overwrite: the next read must
    // re-derive from the DB rather than trust a value this call guessed.
    assert.deepEqual(log.sets, []);
  });

  it('writes the row with the admin id and the new value', async () => {
    const { cache } = recordingCache();
    __setPushFlagCacheForTests(cache);
    const writes: Record<string, unknown>[] = [];
    await setPushEnabled(false, fakeDb({ value: true, writes, audits: [] }), 'Uadmin');

    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.key, 'push_enabled');
    assert.equal(writes[0]!.value, false);
    assert.equal(writes[0]!.updated_by, 'Uadmin');
  });

  it('records an audit row carrying both the before and after value', async () => {
    const { cache } = recordingCache();
    __setPushFlagCacheForTests(cache);
    const audits: Record<string, unknown>[] = [];
    await setPushEnabled(false, fakeDb({ value: true, writes: [], audits }), 'Uadmin');

    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.table, 'admin_audit_log');
    assert.equal(audits[0]!.action, 'setting_push_enabled');
    assert.equal(audits[0]!.admin_line_id, 'Uadmin');
    assert.deepEqual(audits[0]!.before, { pushEnabled: true });
    assert.deepEqual(audits[0]!.after, { pushEnabled: false });
  });

  it('THROWS when the audit insert fails, so the route can revert and 500', async () => {
    // The fail-safe half of the contract: a switch flipped with no record of who
    // flipped it must not be reported as a success.
    const { cache } = recordingCache();
    __setPushFlagCacheForTests(cache);
    await assert.rejects(
      () => setPushEnabled(false, fakeDb({ value: true, auditFails: true, writes: [], audits: [] }), 'Uadmin'),
      /audit write failed/,
    );
  });

  it('still invalidates the cache on the audit failure path', async () => {
    // The revert writes the old value back; leaving a cache entry from the
    // failed attempt would contradict whatever ends up in the DB.
    const { cache, log } = recordingCache({ 'settings:push_enabled': '1' });
    __setPushFlagCacheForTests(cache);
    await assert.rejects(() =>
      setPushEnabled(false, fakeDb({ value: true, auditFails: true, writes: [], audits: [] }), 'Uadmin'),
    );
    assert.deepEqual(log.dels, ['settings:push_enabled']);
  });
});

describe('readPushEnabledUncached', () => {
  it('never consults the cache — an admin must see the DB, not a 60s-old copy', async () => {
    const { cache, log } = recordingCache({ 'settings:push_enabled': '0' });
    __setPushFlagCacheForTests(cache);
    assert.equal(await readPushEnabledUncached(fakeDb({ value: true })), true);
    assert.deepEqual(log.gets, []);
  });

  it('THROWS on a read error rather than inventing a default', async () => {
    // Opposite posture to getPushEnabled by design: a toggle rendered from a
    // fabricated value is a switch that lies about its own position.
    await assert.rejects(() => readPushEnabledUncached(fakeDb({ value: 'throw' })));
  });
});
