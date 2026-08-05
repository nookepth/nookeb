import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runSheetsTrialExpiry, type RevokeOutcome } from './sheetsTrialExpiry.job';

/**
 * หนูเก็บลองงาน expiry sweep (migration 062).
 *
 * The sweep destroys third-party credentials, so every property here is one
 * whose failure is either a leaked Google grant or a destroyed paying
 * customer's connection:
 *
 *   - A TRIAL USER WHO UPGRADED TO PREMIUM IS NOT TOUCHED. This is the one the
 *     spec's design would have got wrong: their trial row still expires, and a
 *     sweep that only looked at `expires_at` would revoke and delete the
 *     credential of someone who is now paying for the feature.
 *   - Revoke happens BEFORE the local delete, because the encrypted row is the
 *     only copy of the refresh token — deleting first strands a live grant
 *     nobody can ever revoke.
 *   - A transient revoke failure claims NOTHING, so the next run retries. The
 *     spec's 15-minute window would have dropped that user forever.
 *   - A failed push never fails the sweep, and never re-sends.
 *
 * The Supabase fake stubs only the three calls the sweep makes and records
 * them; this suite is about control flow, matching diaryReminder.job.test.ts.
 */

interface TrialUser {
  id: string;
  line_user_id: string | null;
  plan: string | null;
  sheets_trial_expires_at: string;
}

interface Recorded {
  revokeCalls: string[];
  deletes: string[];
  claims: string[];
  pushes: { to: string; text: string }[];
  /** Call order across tables, so "revoke before delete" is assertable. */
  order: string[];
}

function fakeSupabase(
  users: TrialUser[],
  connected: Set<string>,
  rec: Recorded,
): SupabaseClient {
  return {
    from(table: string) {
      if (table === 'users') {
        const builder: Record<string, unknown> = {
          // listExpiredTrials: select → lte → is → order → limit
          select: () => builder,
          lte: () => builder,
          order: () => builder,
          limit: async () => ({ data: users, error: null }),
          // markTrialRevoked: update → eq → is
          update: (patch: Record<string, unknown>) => ({
            eq: (_col: string, id: string) => ({
              is: async () => {
                if (patch.sheets_trial_revoked_at) {
                  rec.claims.push(id);
                  rec.order.push(`claim:${id}`);
                }
                return { error: null };
              },
            }),
          }),
          is: () => builder,
        };
        return builder;
      }
      if (table === 'google_integrations') {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              maybeSingle: async () => ({
                data: connected.has(id)
                  ? { encrypted_token: `enc-${id}`, google_email: `${id}@example.test` }
                  : null,
                error: null,
              }),
            }),
          }),
          delete: () => ({
            eq: async (_col: string, id: string) => {
              rec.deletes.push(id);
              rec.order.push(`delete:${id}`);
              return { error: null };
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
}

function blank(): Recorded {
  return { revokeCalls: [], deletes: [], claims: [], pushes: [], order: [] };
}

const NOW = new Date('2026-08-03T12:00:00.000Z');
const EXPIRED = '2026-08-03T11:00:00.000Z';

function user(id: string, plan = 'free', lineId: string | null = `U-${id}`): TrialUser {
  return { id, line_user_id: lineId, plan, sheets_trial_expires_at: EXPIRED };
}

function deps(
  rec: Recorded,
  revokeResult: (userId: string) => RevokeOutcome = () => 'REVOKED_SUCCESS',
) {
  return {
    revokeGrant: async (userId: string) => {
      rec.revokeCalls.push(userId);
      rec.order.push(`revoke:${userId}`);
      return revokeResult(userId);
    },
    push: async (to: string, text: string) => {
      rec.pushes.push({ to, text });
    },
    webUrl: 'https://example.test',
    now: NOW,
  };
}

describe('runSheetsTrialExpiry', () => {
  it('revokes at Google BEFORE deleting the local credential', async () => {
    const rec = blank();
    const supabase = fakeSupabase([user('u1')], new Set(['u1']), rec);

    const result = await runSheetsTrialExpiry(supabase, deps(rec));

    assert.deepEqual(rec.order, ['revoke:u1', 'delete:u1', 'claim:u1']);
    assert.equal(result.revoked, 1);
    assert.equal(rec.pushes.length, 1);
  });

  it('does NOT touch the credential of a user who upgraded to premium', async () => {
    // The bug this test exists for: their trial row still expires, but the
    // connection is now held by their plan. Revoking it would destroy a paying
    // customer's working integration as a side effect of a trial they no
    // longer need.
    const rec = blank();
    const supabase = fakeSupabase([user('paid', 'premium')], new Set(['paid']), rec);

    const result = await runSheetsTrialExpiry(supabase, deps(rec));

    assert.deepEqual(rec.revokeCalls, [], 'must not revoke a premium user');
    assert.deepEqual(rec.deletes, [], 'must not delete a premium user credential');
    assert.deepEqual(rec.pushes, [], 'must not tell them anything was cut off');
    // The trial is still CLAIMED, so it is not re-examined every 15 minutes.
    assert.deepEqual(rec.claims, ['paid']);
    assert.equal(result.keptOnPlan, 1);
    assert.equal(result.revoked, 0);
  });

  it("treats legacy 'team' rows as premium, like the rest of the codebase", async () => {
    const rec = blank();
    const supabase = fakeSupabase([user('legacy', 'team')], new Set(['legacy']), rec);
    const result = await runSheetsTrialExpiry(supabase, deps(rec));
    assert.equal(result.keptOnPlan, 1);
    assert.deepEqual(rec.revokeCalls, []);
  });

  it('claims nothing when Google is unreachable, so the next run retries', async () => {
    const rec = blank();
    const supabase = fakeSupabase([user('u1')], new Set(['u1']), rec);

    const result = await runSheetsTrialExpiry(supabase, deps(rec, () => 'REVOKE_FAILED_TRANSIENT'));

    assert.deepEqual(rec.deletes, [], 'the only copy of the token must survive a retry');
    assert.deepEqual(rec.claims, [], 'claiming here would strand a live grant forever');
    assert.equal(result.deferred, 1);
    assert.equal(result.revoked, 0);
  });

  it('claims a user with no credential without pushing at them', async () => {
    // Disconnected before the trial ran out, or never connected. Nothing was
    // taken away, so a "your access ended" notice would just be confusing.
    const rec = blank();
    const supabase = fakeSupabase([user('u1')], new Set(), rec);

    const result = await runSheetsTrialExpiry(supabase, deps(rec));

    assert.deepEqual(rec.revokeCalls, []);
    assert.deepEqual(rec.pushes, []);
    assert.deepEqual(rec.claims, ['u1']);
    assert.equal(result.nothingToRevoke, 1);
  });

  it('completes the revocation even when the notice cannot be sent', async () => {
    const rec = blank();
    const supabase = fakeSupabase([user('u1')], new Set(['u1']), rec);

    const result = await runSheetsTrialExpiry(supabase, {
      ...deps(rec),
      push: async () => {
        throw new Error('LINE push failed');
      },
    });

    // A throw here would fail the BullMQ job and the retry would re-run a user
    // whose credential is already gone. The revocation is what matters.
    assert.equal(result.revoked, 1);
    assert.deepEqual(rec.claims, ['u1']);
  });

  it('sweeps without a push dependency at all', async () => {
    const rec = blank();
    const supabase = fakeSupabase([user('u1')], new Set(['u1']), rec);
    const { push: _push, ...silent } = deps(rec);
    const result = await runSheetsTrialExpiry(supabase, silent);
    assert.equal(result.revoked, 1);
  });

  it('isolates one failing user from the rest of the batch', async () => {
    const rec = blank();
    const supabase = fakeSupabase(
      [user('bad'), user('good')],
      new Set(['bad', 'good']),
      rec,
    );

    const result = await runSheetsTrialExpiry(supabase, {
      ...deps(rec),
      revokeGrant: async (userId: string) => {
        rec.revokeCalls.push(userId);
        if (userId === 'bad') throw new Error('boom');
        rec.order.push(`revoke:${userId}`);
        return 'REVOKED_SUCCESS' as const;
      },
    });

    assert.equal(result.revoked, 1);
    assert.deepEqual(rec.claims, ['good']);
    assert.equal(result.examined, 2);
  });

  // -------------------------------------------------------------------------
  // FIX 2 — a decrypt failure is NOT a successful revoke.
  //
  // Before the three-state RevokeOutcome, revokeRefreshToken returned `true`
  // when decryptSecret threw. `true` is what this sweep reads as "Google has
  // confirmed the grant is gone, destroy the credential" — so it deleted the
  // row while the grant stayed live at Google, with nothing left able to revoke
  // it and no record of which account it was on. A VAULT_MASTER_KEY rotation
  // makes every stored token undecryptable at once, so a single sweep after a
  // rotation would have orphaned every grant in the product.
  // -------------------------------------------------------------------------
  describe('when the stored token cannot be decrypted', () => {
    const undecryptable = (): RevokeOutcome => 'DECRYPT_FAILED_PERMANENT';

    it('records the orphaned grant BEFORE deleting the credential', async () => {
      const rec = blank();
      const recorded: { userId: string; googleEmail: string | null }[] = [];
      const supabase = fakeSupabase([user('u1')], new Set(['u1']), rec);

      const result = await runSheetsTrialExpiry(supabase, {
        ...deps(rec, undecryptable),
        recordOrphan: async (o) => {
          recorded.push({ userId: o.userId, googleEmail: o.googleEmail });
          rec.order.push(`orphan:${o.userId}`);
          return true;
        },
      });

      assert.deepEqual(
        rec.order,
        ['revoke:u1', 'orphan:u1', 'delete:u1', 'claim:u1'],
        'the durable record must exist before the row is destroyed',
      );
      // The email is the only thing that tells a human WHICH Google account
      // still carries the grant, and the row holding it is about to go.
      assert.deepEqual(recorded, [{ userId: 'u1', googleEmail: 'u1@example.test' }]);
      assert.equal(result.orphaned, 1);
      assert.equal(result.revoked, 0, 'this must never be counted as a revocation');
    });

    it('does NOT count the orphan as revoked, and sends no expiry notice', async () => {
      // The notice says the permission was handed back to Google. For an
      // orphaned grant that is false, and a false reassurance is worse than
      // silence — the user would never go and remove it themselves.
      const rec = blank();
      const result = await runSheetsTrialExpiry(fakeSupabase([user('u1')], new Set(['u1']), rec), {
        ...deps(rec, undecryptable),
        recordOrphan: async () => true,
      });

      assert.deepEqual(rec.pushes, []);
      assert.equal(result.orphaned, 1);
    });

    it('deletes NOTHING when the orphan record could not be written', async () => {
      // The record is a precondition, not a side effect: without it the grant
      // becomes invisible forever the moment the row is deleted. So a failed
      // record leaves everything in place and the next run tries again.
      const rec = blank();
      const result = await runSheetsTrialExpiry(fakeSupabase([user('u1')], new Set(['u1']), rec), {
        ...deps(rec, undecryptable),
        recordOrphan: async () => false,
      });

      assert.deepEqual(rec.deletes, []);
      assert.deepEqual(rec.claims, [], 'claiming would drop this user from the sweep forever');
      assert.equal(result.orphaned, 0);
      assert.equal(result.deferred, 1);
    });

    it('deletes NOTHING when no recorder is wired up at all', async () => {
      // A missing dependency must fail in the same direction as a failed write.
      const rec = blank();
      const result = await runSheetsTrialExpiry(
        fakeSupabase([user('u1')], new Set(['u1']), rec),
        deps(rec, undecryptable),
      );

      assert.deepEqual(rec.deletes, []);
      assert.deepEqual(rec.claims, []);
      assert.equal(result.deferred, 1);
    });

    it('treats a throwing recorder as a failed record', async () => {
      const rec = blank();
      const result = await runSheetsTrialExpiry(fakeSupabase([user('u1')], new Set(['u1']), rec), {
        ...deps(rec, undecryptable),
        recordOrphan: async () => {
          throw new Error('audit table unavailable');
        },
      });

      assert.deepEqual(rec.deletes, []);
      assert.equal(result.deferred, 1);
    });
  });

  // FIX 5 — the per-run cap has to be observable, or a backlog drains ever more
  // slowly with expired trials keeping their Google credentials and nothing
  // anywhere saying so.
  describe('batch cap reporting', () => {
    it('reports atCap when the run comes back holding exactly its cap', async () => {
      const rec = blank();
      const supabase = fakeSupabase([user('a'), user('b')], new Set(), rec);
      const result = await runSheetsTrialExpiry(supabase, { ...deps(rec), batchSize: 2 });

      assert.equal(result.atCap, true);
      assert.equal(result.batchSize, 2);
    });

    it('does not report atCap when the run came back under its cap', async () => {
      const rec = blank();
      const supabase = fakeSupabase([user('a')], new Set(), rec);
      const result = await runSheetsTrialExpiry(supabase, { ...deps(rec), batchSize: 2 });

      assert.equal(result.atCap, false);
    });

    it('reports atCap on an over-full result rather than reading it as headroom', async () => {
      // `>=`, not `===`: a limit is a ceiling, and a query that somehow returned
      // more than it must never read as "comfortably under".
      const rec = blank();
      const supabase = fakeSupabase([user('a'), user('b'), user('c')], new Set(), rec);
      const result = await runSheetsTrialExpiry(supabase, { ...deps(rec), batchSize: 2 });

      assert.equal(result.atCap, true);
    });
  });

  it('skips silently on a pre-062 database', async () => {
    const rec = blank();
    const supabase = {
      from: () => ({
        select: () => ({
          lte: () => ({
            is: () => ({
              order: () => ({
                limit: async () => ({
                  data: null,
                  error: { code: '42703', message: 'column does not exist' },
                }),
              }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    const result = await runSheetsTrialExpiry(supabase, deps(rec));
    assert.equal(result.skipped, true);
    assert.equal(result.examined, 0);
    assert.deepEqual(rec.revokeCalls, []);
  });
});
