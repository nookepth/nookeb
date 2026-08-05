import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runGoogleRevokeRetry, REVOKE_STUCK_AFTER_ATTEMPTS } from './googleRevokeRetry.job';
import type { RevokeOutcome } from './sheetsTrialExpiry.job';
import { __setRevokeColumnsSupportedForTests } from '../services/google-sheets.service';

/**
 * FIX 1 — the parked-disconnect retry.
 *
 * The property under test is the one whose failure is a permanently
 * unrevocable Google grant: THE ROW IS NEVER DELETED UNTIL GOOGLE HAS ACTUALLY
 * SAID THE GRANT IS GONE. The encrypted refresh token in that row is the only
 * thing in existence that can revoke it, so a delete on a failed revoke is not
 * a lost retry — it is a credential we handed out and can never take back.
 */

interface Recorded {
  revokes: string[];
  deletes: string[];
  attemptBumps: { userId: string; attempts: number }[];
  order: string[];
}

interface ParkedRow {
  user_id: string;
  encrypted_token: string;
  revoke_pending_at: string;
  revoke_attempts: number;
}

function blank(): Recorded {
  return { revokes: [], deletes: [], attemptBumps: [], order: [] };
}

function fakeSupabase(rows: ParkedRow[], rec: Recorded): SupabaseClient {
  return {
    from(table: string) {
      assert.equal(table, 'google_integrations');
      const builder: Record<string, unknown> = {
        // listPendingRevocations: select → not → order → limit
        select: () => builder,
        not: () => builder,
        order: () => builder,
        limit: async () => ({ data: rows, error: null }),
        // recordRevokeRetryFailure: update → eq
        update: (patch: Record<string, unknown>) => ({
          eq: async (_col: string, id: string) => {
            rec.attemptBumps.push({ userId: id, attempts: Number(patch.revoke_attempts) });
            return { error: null };
          },
        }),
        delete: () => ({
          eq: async (_col: string, id: string) => {
            rec.deletes.push(id);
            rec.order.push(`delete:${id}`);
            return { error: null };
          },
        }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

function parked(id: string, attempts = 0): ParkedRow {
  return {
    user_id: id,
    encrypted_token: `enc-${id}`,
    revoke_pending_at: '2026-08-03T10:00:00.000Z',
    revoke_attempts: attempts,
  };
}

function deps(
  rec: Recorded,
  revokeResult: (userId: string) => RevokeOutcome = () => 'REVOKED_SUCCESS',
) {
  return {
    revokeGrant: async (userId: string) => {
      rec.revokes.push(userId);
      rec.order.push(`revoke:${userId}`);
      return revokeResult(userId);
    },
  };
}

const TRANSIENT = (): RevokeOutcome => 'REVOKE_FAILED_TRANSIENT';

describe('runGoogleRevokeRetry', () => {
  beforeEach(() => {
    // The service learns "migration 063 is missing" from a PostgREST error and
    // remembers it process-wide. Reset it, or a later test's fake error would
    // leak into an earlier-registered one.
    __setRevokeColumnsSupportedForTests(true);
  });

  it('revokes at Google BEFORE deleting the parked credential', async () => {
    const rec = blank();
    const result = await runGoogleRevokeRetry(fakeSupabase([parked('u1')], rec), deps(rec));

    assert.deepEqual(rec.order, ['revoke:u1', 'delete:u1']);
    assert.equal(result.completed, 1);
  });

  it('does NOT delete the row while the revoke keeps failing', async () => {
    // THE fix-1 regression test. Deleting here destroys the only copy of the
    // refresh token and the grant at Google outlives us permanently.
    const rec = blank();
    const result = await runGoogleRevokeRetry(
      fakeSupabase([parked('u1')], rec),
      deps(rec, TRANSIENT),
    );

    assert.deepEqual(rec.deletes, [], 'the only copy of the token must survive');
    assert.equal(result.stillPending, 1);
    assert.equal(result.completed, 0);
  });

  it('keeps the row queued across runs until the revoke finally succeeds', async () => {
    const rec = blank();
    let googleIsUp = false;
    const row = parked('u1');
    const supabase = fakeSupabase([row], rec);
    const d = deps(rec, () => (googleIsUp ? 'REVOKED_SUCCESS' : 'REVOKE_FAILED_TRANSIENT'));

    const first = await runGoogleRevokeRetry(supabase, d);
    assert.equal(first.stillPending, 1);
    assert.deepEqual(rec.deletes, []);

    const second = await runGoogleRevokeRetry(supabase, d);
    assert.equal(second.stillPending, 1);
    assert.deepEqual(rec.deletes, [], 'still parked, still not deleted');

    googleIsUp = true;
    const third = await runGoogleRevokeRetry(supabase, d);
    assert.equal(third.completed, 1);
    assert.deepEqual(rec.deletes, ['u1'], 'deleted only once the grant is actually gone');
  });

  it('bumps the attempt counter without moving revoke_pending_at', async () => {
    // revoke_pending_at answers "how long has this grant been outstanding?".
    // A retry that refreshed it would reset the one clock that makes a
    // permanently stuck grant visible, so only the counter may move.
    const rec = blank();
    await runGoogleRevokeRetry(fakeSupabase([parked('u1', 4)], rec), deps(rec, TRANSIENT));

    assert.deepEqual(rec.attemptBumps, [{ userId: 'u1', attempts: 5 }]);
  });

  it('reports a row as stuck once it passes the attempt threshold', async () => {
    const rec = blank();
    const stuckReports: string[] = [];

    const result = await runGoogleRevokeRetry(
      fakeSupabase([parked('u1', REVOKE_STUCK_AFTER_ATTEMPTS - 1)], rec),
      {
        ...deps(rec, TRANSIENT),
        onStuck: async (row) => {
          stuckReports.push(row.user_id);
        },
      },
    );

    assert.equal(result.stuck, 1);
    assert.deepEqual(stuckReports, ['u1']);
    assert.deepEqual(rec.deletes, [], 'stuck still never means delete');
  });

  it('does not report a row as stuck before the threshold', async () => {
    const rec = blank();
    const stuckReports: string[] = [];
    const result = await runGoogleRevokeRetry(fakeSupabase([parked('u1', 0)], rec), {
      ...deps(rec, TRANSIENT),
      onStuck: async (row) => {
        stuckReports.push(row.user_id);
      },
    });
    assert.equal(result.stuck, 0);
    assert.deepEqual(stuckReports, []);
  });

  it('isolates one failing row from the rest of the batch', async () => {
    const rec = blank();
    const result = await runGoogleRevokeRetry(
      fakeSupabase([parked('bad'), parked('good')], rec),
      {
        revokeGrant: async (userId: string) => {
          rec.revokes.push(userId);
          if (userId === 'bad') throw new Error('boom');
          rec.order.push(`revoke:${userId}`);
          return 'REVOKED_SUCCESS' as const;
        },
      },
    );

    assert.equal(result.examined, 2);
    assert.equal(result.completed, 1);
    assert.deepEqual(rec.deletes, ['good']);
  });

  // FIX 2 — the same precondition as the trial sweep: a grant that can never be
  // revoked must be recorded before the row that points at it is destroyed.
  describe('when the parked token cannot be decrypted', () => {
    const undecryptable = (): RevokeOutcome => 'DECRYPT_FAILED_PERMANENT';

    it('records the orphan, then removes the dead row', async () => {
      const rec = blank();
      const recorded: string[] = [];

      const result = await runGoogleRevokeRetry(fakeSupabase([parked('u1')], rec), {
        ...deps(rec, undecryptable),
        recordOrphan: async (o) => {
          recorded.push(o.userId);
          rec.order.push(`orphan:${o.userId}`);
          return true;
        },
      });

      assert.deepEqual(rec.order, ['revoke:u1', 'orphan:u1', 'delete:u1']);
      assert.deepEqual(recorded, ['u1']);
      assert.equal(result.orphaned, 1);
      assert.equal(result.completed, 0, 'an orphan is not a completed revocation');
    });

    it('keeps the row parked when the orphan record could not be written', async () => {
      const rec = blank();
      const result = await runGoogleRevokeRetry(fakeSupabase([parked('u1')], rec), {
        ...deps(rec, undecryptable),
        recordOrphan: async () => false,
      });

      assert.deepEqual(rec.deletes, []);
      assert.equal(result.orphaned, 0);
      assert.equal(result.stillPending, 1);
    });

    it('keeps the row parked when no recorder is wired up', async () => {
      const rec = blank();
      const result = await runGoogleRevokeRetry(
        fakeSupabase([parked('u1')], rec),
        deps(rec, undecryptable),
      );
      assert.deepEqual(rec.deletes, []);
      assert.equal(result.stillPending, 1);
    });
  });

  it('skips silently on a pre-063 database', async () => {
    const rec = blank();
    const supabase = {
      from: () => ({
        select: () => ({
          not: () => ({
            order: () => ({
              limit: async () => ({
                data: null,
                error: { code: '42703', message: 'column revoke_pending_at does not exist' },
              }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    const result = await runGoogleRevokeRetry(supabase, deps(rec));
    assert.equal(result.skipped, true);
    assert.deepEqual(rec.revokes, []);
    assert.deepEqual(rec.deletes, []);
  });
});
