import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OAUTH_STATE_TTL_SECONDS,
  claimOAuthState,
  oauthStateKey,
  storeOAuthState,
} from './google-oauth-state';

/**
 * In-memory Redis honouring exactly the subset the state store uses:
 * `set(key, value, 'EX', seconds)` and `getdel(key)`, with a settable clock so
 * TTL expiry is testable without real time. Mirrors the FakeRedis in
 * task-confirm.test.ts.
 */
class FakeRedis {
  private store = new Map<string, { value: string; expireAt: number | null }>();
  public now = 0;

  private live(key: string): string | null {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expireAt !== null && this.now >= e.expireAt) {
      this.store.delete(key);
      return null;
    }
    return e.value;
  }

  async set(key: string, value: string, ...opts: unknown[]): Promise<'OK'> {
    let expireAt: number | null = null;
    for (let i = 0; i < opts.length; i += 1) {
      if (opts[i] === 'EX') expireAt = this.now + Number(opts[i + 1]) * 1000;
    }
    this.store.set(key, { value, expireAt });
    return 'OK';
  }

  async getdel(key: string): Promise<string | null> {
    const value = this.live(key);
    if (value !== null) this.store.delete(key);
    return value;
  }
}

const NONCE = 'nonce-abc-123';
const USER_ID = 'user-uuid-1';

test('claim returns null when the state was never stored (unknown nonce → 401 path)', async () => {
  const redis = new FakeRedis();
  const bound = await claimOAuthState(redis, NONCE);
  assert.equal(bound, null);
});

test('a stored state binds the nonce to its user id and can be claimed once', async () => {
  const redis = new FakeRedis();
  await storeOAuthState(redis, NONCE, USER_ID);
  // Stored under the namespaced key, not the bare nonce.
  assert.equal(await redis.getdel(oauthStateKey(NONCE)), USER_ID);
});

test('claim returns the bound user id for a valid, unexpired nonce', async () => {
  const redis = new FakeRedis();
  await storeOAuthState(redis, NONCE, USER_ID);
  const bound = await claimOAuthState(redis, NONCE);
  assert.equal(bound, USER_ID);
});

test('an expired state claims as null (nonce older than the TTL → 401 path)', async () => {
  const redis = new FakeRedis();
  await storeOAuthState(redis, NONCE, USER_ID);
  // Advance just past the TTL window.
  redis.now = OAUTH_STATE_TTL_SECONDS * 1000 + 1;
  const bound = await claimOAuthState(redis, NONCE);
  assert.equal(bound, null);
});

test('replay is rejected: the second claim of the same nonce is null (single-use GETDEL)', async () => {
  const redis = new FakeRedis();
  await storeOAuthState(redis, NONCE, USER_ID);

  const first = await claimOAuthState(redis, NONCE);
  assert.equal(first, USER_ID, 'first claim succeeds');

  const second = await claimOAuthState(redis, NONCE);
  assert.equal(second, null, 'replayed callback finds nothing');
});

test('state survives right up to the TTL boundary (no premature expiry)', async () => {
  const redis = new FakeRedis();
  await storeOAuthState(redis, NONCE, USER_ID);
  // One millisecond before expiry it is still valid.
  redis.now = OAUTH_STATE_TTL_SECONDS * 1000 - 1;
  assert.equal(await claimOAuthState(redis, NONCE), USER_ID);
});
