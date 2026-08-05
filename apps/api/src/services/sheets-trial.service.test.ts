import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_TRIAL,
  evaluateTrial,
  listExpiredTrials,
  type SheetsTrialRow,
} from './sheets-trial.service';

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

/**
 * FIX 6 — the sweep's driving query filters on `activated_at IS NOT NULL`
 * ITSELF, rather than relying on migration 062's coherence CHECK to imply it.
 *
 * The old query was `expires_at <= now AND revoked_at IS NULL`. That only
 * excludes a user who never started a trial because the CHECK guarantees
 * activated_at and expires_at are written together, so a NULL activated_at
 * implies a NULL expires_at, which `lte(...)` filters out.
 *
 * Correct, and fragile: it depends on a constraint in another file, applied by
 * hand, on a table whose columns may already exist elsewhere — exactly the case
 * where the `ADD COLUMN IF NOT EXISTS` statements succeed and the CHECK is the
 * part that gets skipped. And the sweep's response to a matched row is to revoke
 * that user's Google grant and delete their credential.
 *
 * These tests run WITHOUT the constraint by construction — the fake applies only
 * the predicates the code actually sends — so a row that could only exist on a
 * database missing the CHECK is exactly what they feed it.
 */
describe('listExpiredTrials — FIX 6', () => {
  interface FakeRow {
    id: string;
    sheets_trial_activated_at: string | null;
    sheets_trial_expires_at: string | null;
    sheets_trial_revoked_at: string | null;
  }

  /**
   * Applies the filters the query actually sends, and NOTHING else. No CHECK
   * constraint exists here — which is the whole point.
   */
  function fakeSupabase(rows: FakeRow[]) {
    const filters: { op: string; col: string; val: unknown }[] = [];
    const b: Record<string, unknown> = {
      from: () => b,
      select: () => b,
      order: () => b,
      not: (col: string, _op: string, val: unknown) => {
        filters.push({ op: 'not-is', col, val });
        return b;
      },
      lte: (col: string, val: unknown) => {
        filters.push({ op: 'lte', col, val });
        return b;
      },
      is: (col: string, val: unknown) => {
        filters.push({ op: 'is', col, val });
        return b;
      },
      limit: async () => ({
        data: rows.filter((r) =>
          filters.every(({ op, col, val }) => {
            const cur = (r as unknown as Record<string, unknown>)[col];
            if (op === 'is') return cur === val;
            if (op === 'not-is') return cur !== val;
            if (op === 'lte') return cur !== null && String(cur) <= String(val);
            return true;
          }),
        ),
        error: null,
      }),
    };
    return b as unknown as import('@supabase/supabase-js').SupabaseClient;
  }

  const NOW = new Date('2026-08-05T12:00:00.000Z');
  const PAST = '2026-08-01T00:00:00.000Z';

  it('never returns a row whose activation stamp is missing', async () => {
    // The row this fix exists for: an expiry with no activation. It can only
    // occur on a database missing 062's CHECK, and the old query would have
    // handed it to the sweep, which revokes and deletes credentials.
    const supabase = fakeSupabase([
      {
        id: 'half-written',
        sheets_trial_activated_at: null,
        sheets_trial_expires_at: PAST,
        sheets_trial_revoked_at: null,
      },
    ]);

    const { users } = await listExpiredTrials(supabase, NOW, 100);
    assert.deepEqual(users, [], 'a row with no activation must never reach the sweep');
  });

  it('still returns a genuinely expired, uncleaned trial', async () => {
    const supabase = fakeSupabase([
      {
        id: 'real',
        sheets_trial_activated_at: '2026-07-18T00:00:00.000Z',
        sheets_trial_expires_at: PAST,
        sheets_trial_revoked_at: null,
      },
    ]);

    const { users } = await listExpiredTrials(supabase, NOW, 100);
    assert.equal(users.length, 1);
    assert.equal((users[0] as unknown as FakeRow).id, 'real');
  });

  it('picks the real trial out of a table full of users who never started one', async () => {
    const never = (id: string): FakeRow => ({
      id,
      sheets_trial_activated_at: null,
      sheets_trial_expires_at: null,
      sheets_trial_revoked_at: null,
    });
    const supabase = fakeSupabase([
      never('u1'),
      never('u2'),
      {
        id: 'real',
        sheets_trial_activated_at: '2026-07-18T00:00:00.000Z',
        sheets_trial_expires_at: PAST,
        sheets_trial_revoked_at: null,
      },
      never('u3'),
    ]);

    const { users } = await listExpiredTrials(supabase, NOW, 100);
    assert.deepEqual(
      users.map((u) => u.id),
      ['real'],
    );
  });

  it('still excludes a trial the sweep has already claimed', async () => {
    const supabase = fakeSupabase([
      {
        id: 'done',
        sheets_trial_activated_at: '2026-07-18T00:00:00.000Z',
        sheets_trial_expires_at: PAST,
        sheets_trial_revoked_at: '2026-08-02T00:00:00.000Z',
      },
    ]);

    const { users } = await listExpiredTrials(supabase, NOW, 100);
    assert.deepEqual(users, []);
  });
});
