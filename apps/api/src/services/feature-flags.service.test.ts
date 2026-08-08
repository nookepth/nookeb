import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  __setFeatureFlagCacheForTests,
  __setFeatureFlagDbForTests,
  FEATURE_FLAG_KEYS,
  getFlag,
  isFeatureFlagKey,
  readFlagUncached,
  setFlag,
  type FeatureFlagCache,
} from './feature-flags.service';

/**
 * DB-backed feature flags (migrations 059 + 061).
 *
 * The safety property is FAIL OPEN TO THE CALLER'S FALLBACK: whatever breaks —
 * Redis, Supabase, an unapplied migration, a malformed value — the product must
 * keep behaving the way it did before TIER 3 moved these decisions into a
 * table. Each call site names its own safe direction, because the safe
 * direction differs per flag: a missing scan_enhance_enabled should read TRUE
 * (keep enhancing), a missing diary_reminder_enabled should read FALSE (do not
 * start messaging people).
 *
 * So, as with push-flag.service.test.ts, these tests hammer the failure paths.
 */

interface CacheLog {
  gets: string[];
  sets: { key: string; value: string; ttl: number }[];
  dels: string[];
}

function recordingCache(seed?: Record<string, string>): { cache: FeatureFlagCache; log: CacheLog } {
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

/** Every operation throws — a Redis outage. */
const deadCache: FeatureFlagCache = {
  get: () => Promise.reject(new Error('ECONNREFUSED')),
  set: () => Promise.reject(new Error('ECONNREFUSED')),
  del: () => Promise.reject(new Error('ECONNREFUSED')),
};

/**
 * Minimal Supabase stand-in covering the two shapes this module uses:
 *   .from(t).select(c).eq(k, v).maybeSingle()
 *   .from(t).upsert(row, opts) / .from(t).insert(row)
 */
function fakeDb(opts: {
  value: unknown | 'throw' | 'missing';
  auditFails?: boolean;
  writes?: Record<string, unknown>[];
  audits?: Record<string, unknown>[];
}): SupabaseClient {
  const from = (table: string): Record<string, unknown> => {
    const builder: Record<string, unknown> = {};
    ['select', 'eq'].forEach((name) => {
      builder[name] = () => builder;
    });
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
      return opts.auditFails
        ? { data: null, error: { message: 'audit down' } }
        : { data: null, error: null };
    };
    return builder;
  };
  return { from } as unknown as SupabaseClient;
}

afterEach(() => {
  __setFeatureFlagCacheForTests(null);
  __setFeatureFlagDbForTests(null);
});

describe('getFlag — fail open to the caller fallback', () => {
  it('returns the fallback when Redis is down AND the DB read fails', async () => {
    // The nightmare case: both dependencies gone. The product keeps behaving.
    __setFeatureFlagCacheForTests(deadCache);
    __setFeatureFlagDbForTests(fakeDb({ value: 'throw' }));
    assert.equal(await getFlag('scan_enhance_enabled', true), true);
    assert.equal(await getFlag('diary_reminder_enabled', false), false);
  });

  it('returns the fallback when only the DB read fails', async () => {
    const { cache } = recordingCache();
    __setFeatureFlagCacheForTests(cache);
    __setFeatureFlagDbForTests(fakeDb({ value: 'throw' }));
    assert.equal(await getFlag('scan_ocr_enabled', true), true);
  });

  it('returns the fallback when the row is missing (migration 061 unapplied)', async () => {
    const { cache } = recordingCache();
    __setFeatureFlagCacheForTests(cache);
    __setFeatureFlagDbForTests(fakeDb({ value: 'missing' }));
    assert.equal(await getFlag('diary_addon_enabled', true), true);
    assert.equal(await getFlag('diary_reminder_enabled', false), false);
  });

  it('does NOT cache a fallback — one blip must not become a minute of guessing', async () => {
    const { cache, log } = recordingCache();
    __setFeatureFlagCacheForTests(cache);
    __setFeatureFlagDbForTests(fakeDb({ value: 'throw' }));
    await getFlag('scan_enhance_enabled', true);
    assert.deepEqual(log.sets, []);
  });

  it('falls through to the DB when only Redis is down, and still honours a real false', async () => {
    // A dead cache must not be mistaken for "no setting". Fail-open is about
    // ERRORS, not about ignoring the admin's decision.
    __setFeatureFlagCacheForTests(deadCache);
    __setFeatureFlagDbForTests(fakeDb({ value: false }));
    assert.equal(await getFlag('scan_enhance_enabled', true), false);
  });

  it('falls back for any non-boolean value — a malformed write cannot flip a switch', async () => {
    // Boolean("false") is true. Coercing here is how a bad write turns a flag
    // the wrong way round.
    const { cache } = recordingCache();
    for (const junk of ['false', 'true', 0, 1, {}, [], null]) {
      __setFeatureFlagCacheForTests(cache);
      __setFeatureFlagDbForTests(fakeDb({ value: junk }));
      assert.equal(
        await getFlag('diary_reminder_enabled', false),
        false,
        `value ${JSON.stringify(junk)}`,
      );
    }
  });
});

describe('getFlag — caching', () => {
  it('serves a cached "off" without touching the DB', async () => {
    const { cache } = recordingCache({ 'flag:scan_ocr_enabled': '0' });
    __setFeatureFlagCacheForTests(cache);
    // A DB that would error if consulted proves the cache short-circuited.
    __setFeatureFlagDbForTests(fakeDb({ value: 'throw' }));
    assert.equal(await getFlag('scan_ocr_enabled', true), false);
  });

  it('caches a real read under flag:{key} with a 300s TTL', async () => {
    const { cache, log } = recordingCache();
    __setFeatureFlagCacheForTests(cache);
    __setFeatureFlagDbForTests(fakeDb({ value: false }));
    await getFlag('scan_enhance_enabled', true);
    assert.deepEqual(log.sets, [{ key: 'flag:scan_enhance_enabled', value: '0', ttl: 300 }]);
  });
});

describe('setFlag', () => {
  it('writes the row with the admin id and invalidates the cache with a DELETE', async () => {
    const { cache, log } = recordingCache({ 'flag:scan_ocr_enabled': '1' });
    __setFeatureFlagCacheForTests(cache);

    const writes: Record<string, unknown>[] = [];
    await setFlag('scan_ocr_enabled', false, fakeDb({ value: true, writes, audits: [] }), 'Uadmin');

    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.key, 'scan_ocr_enabled');
    assert.equal(writes[0]!.value, false);
    assert.equal(writes[0]!.updated_by, 'Uadmin');
    // A DELETE, not an overwrite: the next read must re-derive from the DB
    // rather than trust a value this call guessed.
    assert.deepEqual(log.dels, ['flag:scan_ocr_enabled']);
    assert.deepEqual(log.sets, []);
  });

  it('records an audit row keyed by the flag, carrying before and after', async () => {
    const { cache } = recordingCache();
    __setFeatureFlagCacheForTests(cache);
    const audits: Record<string, unknown>[] = [];
    await setFlag('scan_enhance_enabled', false, fakeDb({ value: true, writes: [], audits }), 'Uadmin');

    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.table, 'admin_audit_log');
    // One verb, the key in target_id — so "what has been switched recently" is
    // a single query rather than six action strings to know about.
    assert.equal(audits[0]!.action, 'setting_flag');
    assert.equal(audits[0]!.target_id, 'scan_enhance_enabled');
    assert.deepEqual(audits[0]!.before, { scan_enhance_enabled: true });
    assert.deepEqual(audits[0]!.after, { scan_enhance_enabled: false });
  });

  it('THROWS when the audit insert fails, so the route can revert and 500', async () => {
    const { cache } = recordingCache();
    __setFeatureFlagCacheForTests(cache);
    await assert.rejects(
      () =>
        setFlag(
          'scan_ocr_enabled',
          false,
          fakeDb({ value: true, auditFails: true, writes: [], audits: [] }),
          'Uadmin',
        ),
      /audit write failed/,
    );
  });
});

describe('readFlagUncached', () => {
  it('never consults the cache — an admin must see the DB, not a cached copy', async () => {
    const { cache, log } = recordingCache({ 'flag:scan_ocr_enabled': '0' });
    __setFeatureFlagCacheForTests(cache);
    assert.equal(await readFlagUncached(fakeDb({ value: true }), 'scan_ocr_enabled'), true);
    assert.deepEqual(log.gets, []);
  });

  it('THROWS on a read error rather than inventing a value', async () => {
    await assert.rejects(() => readFlagUncached(fakeDb({ value: 'throw' }), 'scan_ocr_enabled'));
  });
});

describe('isFeatureFlagKey', () => {
  it('accepts every declared key and rejects anything else', () => {
    // The allowlist is what stops PUT /admin/flags/:key creating a row that
    // looks like a real switch on the page and controls nothing.
    for (const key of FEATURE_FLAG_KEYS) assert.equal(isFeatureFlagKey(key), true, key);
    assert.equal(isFeatureFlagKey('scan_enhanced_enabled'), false); // plausible typo
    assert.equal(isFeatureFlagKey('__proto__'), false);
    assert.equal(isFeatureFlagKey(''), false);
  });
});
