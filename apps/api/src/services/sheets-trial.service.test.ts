import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NO_TRIAL, evaluateTrial, type SheetsTrialRow } from './sheets-trial.service';

/**
 * หนูเก็บลองงาน — the trial state machine (migration 062).
 *
 * `evaluateTrial` is the pure half of the feature and the thing every gate
 * ultimately reads, so the properties pinned here are the ones whose failure
 * would either hand out free access or cut someone off early:
 *
 *   - the cutoff is a strict instant comparison, so the last millisecond of the
 *     trial still works and the first millisecond after it does not;
 *   - "never activated" is its own state, distinct from "expired" — the UI
 *     offers a trial in one and must not in the other;
 *   - the countdown rounds UP, so a trial with hours left never reads "0 วัน"
 *     next to a working connect button.
 */

const DAY = 86_400_000;

function row(activatedAt: string | null, expiresAt: string | null): SheetsTrialRow {
  return {
    plan: 'free',
    sheets_trial_activated_at: activatedAt,
    sheets_trial_expires_at: expiresAt,
    sheets_trial_revoked_at: null,
  };
}

describe('evaluateTrial', () => {
  const now = new Date('2026-08-03T12:00:00.000Z');

  it('reports the never-activated state for a null row', () => {
    assert.deepEqual(evaluateTrial(null, now), NO_TRIAL);
  });

  it('treats "never activated" as neither active nor expired', () => {
    const t = evaluateTrial(row(null, null), now);
    // Not each other's negation — the UI branches on all three states, and
    // collapsing them would offer a fresh trial to someone who used theirs.
    assert.equal(t.isActive, false);
    assert.equal(t.isExpired, false);
    assert.equal(t.activatedAt, null);
    assert.equal(t.daysRemaining, null);
  });

  it('is active with a future expiry', () => {
    const expires = new Date(now.getTime() + 5 * DAY).toISOString();
    const t = evaluateTrial(row('2026-07-29T12:00:00.000Z', expires), now);
    assert.equal(t.isActive, true);
    assert.equal(t.isExpired, false);
    assert.equal(t.daysRemaining, 5);
  });

  it('is still active one millisecond before the deadline', () => {
    const expires = new Date(now.getTime() + 1).toISOString();
    const t = evaluateTrial(row('2026-07-20T12:00:00.000Z', expires), now);
    assert.equal(t.isActive, true, 'the trial must run for its full fourteen days');
  });

  it('is expired exactly AT the deadline', () => {
    // "Hard cutoff at exactly 14 days, no grace period" — the boundary belongs
    // to the expired side.
    const t = evaluateTrial(row('2026-07-20T12:00:00.000Z', now.toISOString()), now);
    assert.equal(t.isActive, false);
    assert.equal(t.isExpired, true);
    assert.equal(t.daysRemaining, 0);
  });

  it('rounds the countdown UP so a partial day never reads as zero', () => {
    const expires = new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString(); // 4 h
    const t = evaluateTrial(row('2026-07-20T12:00:00.000Z', expires), now);
    assert.equal(t.isActive, true);
    assert.equal(t.daysRemaining, 1, '4 hours left is "1 วัน", never "0 วัน"');
  });

  it('never reports a negative countdown', () => {
    const expires = new Date(now.getTime() - 9 * DAY).toISOString();
    const t = evaluateTrial(row('2026-07-01T12:00:00.000Z', expires), now);
    assert.equal(t.daysRemaining, 0);
  });

  it('ignores a half-written row rather than granting unbounded access', () => {
    // Migration 062's CHECK makes this unreachable in the database; the guard
    // here is for a row read through some path that predates it.
    assert.deepEqual(evaluateTrial(row('2026-07-20T12:00:00.000Z', null), now), NO_TRIAL);
    assert.deepEqual(evaluateTrial(row(null, '2026-09-20T12:00:00.000Z'), now), NO_TRIAL);
  });
});
