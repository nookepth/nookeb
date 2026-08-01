import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCapacity, evaluateQuota, quotaExceededPayload } from './quota.service';
import { UNLIMITED } from '../config/plans';

/**
 * The pure decision core of the quota engine. The DB round-trip
 * (consume_quota / release_quota) is exercised by the integration suite; what
 * matters here is that the arithmetic can never be wrong at the boundary,
 * because that is where a paying user is either cheated of their last unit or
 * handed a free one.
 */

describe('evaluateQuota', () => {
  it('allows the very last unit', () => {
    // 9 used of 10 → the 10th scan must go through.
    assert.deepEqual(evaluateQuota({ limit: 10, used: 9 }), { allowed: true, remaining: 1 });
  });

  it('blocks the unit after the last', () => {
    assert.deepEqual(evaluateQuota({ limit: 10, used: 10 }), { allowed: false, remaining: 0 });
  });

  it('allows a fresh quota', () => {
    assert.equal(evaluateQuota({ limit: 7, used: 0 }).allowed, true);
    assert.equal(evaluateQuota({ limit: 7, used: 0 }).remaining, 7);
  });

  it('blocks a zero limit outright', () => {
    // Free-plan boosts. A 0 limit must never behave like "unlimited".
    assert.deepEqual(evaluateQuota({ limit: 0, used: 0 }), { allowed: false, remaining: 0 });
  });

  it('always allows when the limit is unlimited', () => {
    const res = evaluateQuota({ limit: UNLIMITED, used: 1_000_000 });
    assert.equal(res.allowed, true);
    assert.equal(res.remaining, Number.POSITIVE_INFINITY);
  });

  it('handles multi-unit spends (word conversion charges per page)', () => {
    assert.equal(evaluateQuota({ limit: 10, used: 5, amount: 5 }).allowed, true);
    assert.equal(evaluateQuota({ limit: 10, used: 5, amount: 6 }).allowed, false);
    assert.equal(evaluateQuota({ limit: 10, used: 0, amount: 10 }).allowed, true);
    assert.equal(evaluateQuota({ limit: 10, used: 0, amount: 11 }).allowed, false);
  });

  it('never reports negative remaining for an over-limit user', () => {
    // Post-downgrade: 40 used against a new limit of 30. Blocked, but the UI
    // must not render "-10 left".
    const res = evaluateQuota({ limit: 30, used: 40 });
    assert.equal(res.allowed, false);
    assert.equal(res.remaining, 0);
  });

  it('still blocks an over-limit user from a single new unit', () => {
    // The spec: apply the lower limit immediately, block new usage, keep data.
    assert.equal(evaluateQuota({ limit: 30, used: 40, amount: 1 }).allowed, false);
  });

  it('allows a zero-amount probe even when exhausted', () => {
    // "May I?" with nothing to spend must not be refused — it is how a status
    // read asks without a side effect.
    assert.equal(evaluateQuota({ limit: 10, used: 10, amount: 0 }).allowed, true);
  });
});

describe('evaluateCapacity', () => {
  it('rejects the 11th vault file on free', () => {
    const res = evaluateCapacity({ plan: 'free', feature: 'vault_files', currentCount: 10 });
    assert.equal(res.allowed, false);
    assert.equal(res.limit, 10);
    assert.equal(res.used, 10);
  });

  it('allows the 10th vault file on free', () => {
    assert.equal(
      evaluateCapacity({ plan: 'free', feature: 'vault_files', currentCount: 9 }).allowed,
      true,
    );
  });

  it('scales with the plan', () => {
    assert.equal(
      evaluateCapacity({ plan: 'pro', feature: 'vault_files', currentCount: 29 }).allowed,
      true,
    );
    assert.equal(
      evaluateCapacity({ plan: 'pro', feature: 'vault_files', currentCount: 30 }).allowed,
      false,
    );
    assert.equal(
      evaluateCapacity({ plan: 'premium', feature: 'vault_files', currentCount: 99 }).allowed,
      true,
    );
  });

  it('refuses every boost on free', () => {
    const res = evaluateCapacity({ plan: 'free', feature: 'group_boosts', currentCount: 0 });
    assert.equal(res.allowed, false);
    assert.equal(res.limit, 0);
  });

  it('allows exactly one boost on pro and three on premium', () => {
    assert.equal(
      evaluateCapacity({ plan: 'pro', feature: 'group_boosts', currentCount: 0 }).allowed,
      true,
    );
    assert.equal(
      evaluateCapacity({ plan: 'pro', feature: 'group_boosts', currentCount: 1 }).allowed,
      false,
    );
    assert.equal(
      evaluateCapacity({ plan: 'premium', feature: 'group_boosts', currentCount: 2 }).allowed,
      true,
    );
    assert.equal(
      evaluateCapacity({ plan: 'premium', feature: 'group_boosts', currentCount: 3 }).allowed,
      false,
    );
  });

  it('reports no reset instant — capacity limits never reset', () => {
    const res = evaluateCapacity({ plan: 'free', feature: 'vault_files', currentCount: 10 });
    assert.equal(res.resetAt, null);
    assert.equal(res.periodStart, null);
  });
});

describe('quotaExceededPayload', () => {
  it('emits exactly the documented error shape', () => {
    const payload = quotaExceededPayload({
      feature: 'scans',
      scopeId: '',
      limit: 10,
      used: 10,
      remaining: 0,
      unlimited: false,
      periodStart: '2026-08-01',
      resetAt: '2026-08-31T17:00:00.000Z',
    });
    assert.deepEqual(payload, {
      error: 'QUOTA_EXCEEDED',
      feature: 'scans',
      limit: 10,
      used: 10,
      reset_at: '2026-08-31T17:00:00.000Z',
    });
  });

  it('carries a null reset_at for capacity limits', () => {
    const payload = quotaExceededPayload({
      feature: 'vault_files',
      scopeId: '',
      limit: 10,
      used: 10,
      remaining: 0,
      unlimited: false,
      periodStart: null,
      resetAt: null,
    });
    assert.equal(payload.reset_at, null);
    assert.equal(payload.feature, 'vault_files');
  });
});
