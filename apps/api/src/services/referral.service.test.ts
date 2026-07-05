/**
 * Unit tests for referral.service — run with `npm test` (node:test via tsx).
 *
 * The service module pulls in config.ts, which validates required env vars at
 * import time — so the env stubs below MUST run before the service is loaded.
 * That's why the service is loaded with a dynamic import() (executed after the
 * assignments) instead of a hoisted static import.
 *
 * Supabase + Redis are in-memory fakes (no real DB / network). The fake
 * `rpc('redeem_referral')` mirrors the migration-010 function's contract:
 * referee gets referred_by_id + flat bonus, referrer gets count+1 and a
 * tier-table storage_limit (bonus preserved), double-redeem raises 23505.
 */
process.env.LINE_CHANNEL_ID ??= 'test-channel-id';
process.env.LINE_CHANNEL_SECRET ??= 'test-channel-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN ??= 'test-access-token';
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key';
process.env.R2_ACCOUNT_ID ??= 'test-account';
process.env.R2_ACCESS_KEY_ID ??= 'test-key';
process.env.R2_SECRET_ACCESS_KEY ??= 'test-secret';
process.env.JWT_SECRET ??= 'test-jwt-secret-test-jwt-secret-32ch';
// The tests below assert against the free-tier defaults — pin them so a local
// .env leaking into the test process can't change the expected numbers.
process.env.DEFAULT_STORAGE_LIMIT = String(1024 ** 3); // 1 GB
process.env.REFERRAL_BONUS_BYTES = String(512 * 1024 * 1024); // 0.5 GB

import test from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Redis } from 'ioredis';

const GB = 1024 ** 3;
const BONUS = 512 * 1024 * 1024;

const TIERS = [
  { min_referrals: 0, storage_limit_gb: 1 },
  { min_referrals: 1, storage_limit_gb: 3 },
  { min_referrals: 4, storage_limit_gb: 5 },
  { min_referrals: 7, storage_limit_gb: 7 },
  { min_referrals: 10, storage_limit_gb: 10 },
];

interface FakeUser {
  id: string;
  referral_code: string | null;
  referred_by_id: string | null;
  referral_count: number;
  storage_limit: number;
}

/** Minimal chainable stand-in for the Supabase query builder paths the service uses. */
function fakeSupabase(users: FakeUser[]): SupabaseClient {
  const usersQuery = {
    select(_cols: string) {
      return {
        in: async (_col: string, ids: string[]) => ({
          data: users.filter((u) => ids.includes(u.id)),
          error: null,
        }),
        ilike: (_col: string, value: string) => ({
          maybeSingle: async () => ({
            data:
              users.find((u) => u.referral_code?.toUpperCase() === value.toUpperCase()) ?? null,
            error: null,
          }),
        }),
        eq: (_col: string, id: string) => ({
          maybeSingle: async () => ({ data: users.find((u) => u.id === id) ?? null, error: null }),
        }),
      };
    },
  };
  const tiersQuery = {
    select(_cols: string) {
      return {
        order: async (_col: string, _opts: unknown) => ({ data: [...TIERS], error: null }),
      };
    },
  };
  return {
    from(table: string) {
      if (table === 'users') return usersQuery;
      if (table === 'referral_tiers') return tiersQuery;
      throw new Error(`fakeSupabase: unexpected table ${table}`);
    },
    // Mirrors the redeem_referral() plpgsql function from migration 010.
    async rpc(name: string, params: Record<string, unknown>) {
      if (name !== 'redeem_referral') throw new Error(`fakeSupabase: unexpected rpc ${name}`);
      const referrer = users.find((u) => u.id === params.p_referrer_id)!;
      const referee = users.find((u) => u.id === params.p_referee_id)!;
      const bonus = params.p_bonus_bytes as number;
      if (referee.referred_by_id !== null) {
        return { data: null, error: { code: '23505', message: 'already redeemed' } };
      }
      referee.referred_by_id = referrer.id;
      referee.storage_limit += bonus;
      referrer.referral_count += 1;
      const tier = [...TIERS].reverse().find((t) => t.min_referrals <= referrer.referral_count)!;
      referrer.storage_limit =
        tier.storage_limit_gb * GB + (referrer.referred_by_id !== null ? bonus : 0);
      return { data: referee.storage_limit, error: null };
    },
  } as unknown as SupabaseClient;
}

/** In-memory Redis with just get/set/incr/expire (what the service touches). */
function fakeRedis(): Redis {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string) {
      store.set(key, value);
      return 'OK';
    },
    async incr(key: string) {
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));
      return next;
    },
    async expire() {
      return 1;
    },
  } as unknown as Redis;
}

function user(overrides: Partial<FakeUser> & { id: string }): FakeUser {
  return {
    referral_code: null,
    referred_by_id: null,
    referral_count: 0,
    storage_limit: 1 * GB,
    ...overrides,
  };
}

// Loaded lazily so the env stubs above run before config.ts validates.
const service = import('./referral.service');

test('canRedeem: self-referral is rejected', async () => {
  const { canRedeem } = await service;
  const supabase = fakeSupabase([user({ id: 'A' })]);
  const result = await canRedeem(supabase, 'A', 'A');
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'self');
});

test('canRedeem: referee who already has referred_by_id is rejected', async () => {
  const { canRedeem } = await service;
  const supabase = fakeSupabase([
    user({ id: 'A' }),
    user({ id: 'B', referred_by_id: 'C' }),
  ]);
  const result = await canRedeem(supabase, 'A', 'B');
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'already_redeemed');
});

test('canRedeem: chain (A invited B, B cannot invite A back) is rejected', async () => {
  const { canRedeem } = await service;
  // A was referred by B → B redeeming A's code would close the loop.
  const supabase = fakeSupabase([
    user({ id: 'A', referred_by_id: 'B' }),
    user({ id: 'B' }),
  ]);
  const result = await canRedeem(supabase, 'A', 'B');
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'chain');
});

test('canRedeem: valid new pair is accepted', async () => {
  const { canRedeem } = await service;
  const supabase = fakeSupabase([user({ id: 'A' }), user({ id: 'B' })]);
  const result = await canRedeem(supabase, 'A', 'B');
  assert.deepEqual(result, { ok: true });
});

test('redeemCode: referrer at 0 referrals ends at count 1 and 3 GB', async () => {
  const { redeemCode } = await service;
  const users = [
    user({ id: 'A', referral_code: 'AAAA1111' }),
    user({ id: 'B' }),
  ];
  const result = await redeemCode(fakeSupabase(users), fakeRedis(), 'aaaa1111', 'B');
  assert.equal(result.ok, true);
  assert.equal(result.referrerId, 'A');
  const referrer = users[0]!;
  assert.equal(referrer.referral_count, 1);
  assert.equal(referrer.storage_limit, 3 * GB);
});

test('redeemCode: referee storage increases by REFERRAL_BONUS_BYTES', async () => {
  const { redeemCode } = await service;
  const users = [
    user({ id: 'A', referral_code: 'AAAA1111' }),
    user({ id: 'B', storage_limit: 1 * GB }),
  ];
  const result = await redeemCode(fakeSupabase(users), fakeRedis(), 'AAAA1111', 'B');
  assert.equal(result.ok, true);
  assert.equal(result.newStorageBytes, 1 * GB + BONUS);
  assert.equal(users[1]!.storage_limit, 1 * GB + BONUS);
});

test('getStorageTierBytes: all 5 tiers return the right byte values', async () => {
  const { getStorageTierBytes } = await service;
  const supabase = fakeSupabase([]);
  const redis = fakeRedis();
  const expected: [number, number][] = [
    [0, 1 * GB],
    [1, 3 * GB],
    [4, 5 * GB],
    [7, 7 * GB],
    [10, 10 * GB],
  ];
  for (const [count, bytes] of expected) {
    assert.equal(await getStorageTierBytes(supabase, redis, count), bytes, `tier for ${count}`);
  }
  // in-between counts snap to the tier below
  assert.equal(await getStorageTierBytes(supabase, redis, 3), 3 * GB);
  assert.equal(await getStorageTierBytes(supabase, redis, 12), 10 * GB);
});
