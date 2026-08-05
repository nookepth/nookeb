import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AuthUser } from '../types';

/**
 * FIX 1 — DELETE /integrations/google, end to end through a real Fastify app.
 *
 * THE PROPERTY: the credential row is never deleted while the grant at Google
 * is still alive. The encrypted refresh token in that row is the only thing in
 * existence that can revoke the grant, so "delete first, revoke never" is not a
 * lost cleanup — it is a third-party credential handed out permanently, with no
 * way back even after the bug is found.
 *
 * A real app rather than calling the handler, because the ordering being
 * asserted (revoke → delete, or revoke → park) spans the route, the service and
 * the runtime column-support fallback.
 *
 * `fetch` is stubbed globally: revokeRefreshToken POSTs to Google's revoke
 * endpoint directly, so that is the seam where "Google is down" lives.
 *
 * ── Why this file supplies its own Google/vault config ────────────────────
 *
 * routes/integrations.ts refuses every request with 503 unless
 * isGoogleSheetsConfigured() is true, which needs GOOGLE_CLIENT_* and a
 * VAULT_MASTER_KEY. A developer .env has neither (they are production
 * credentials), so a skip-guard here would mean the one regression test for a
 * permanently-leaked OAuth grant never actually runs — which is how the bug got
 * in. The values below are throwaway locals: the client id/secret are only ever
 * used to construct an OAuth client this test never calls, and the master key
 * just has to be 32 valid hex bytes so encryptSecret/decryptSecret round-trip.
 *
 * They are set BEFORE the imports that read them, which is why those imports are
 * dynamic and live in `before()` — config.ts parses process.env at module load,
 * and a static import would be hoisted above the assignments. (tsx transpiles
 * this suite to CJS, so top-level await is not available either.)
 */

for (const [key, value] of Object.entries({
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  VAULT_MASTER_KEY: '0'.repeat(63) + '1',
})) {
  // Never override a real value — if the suite is run with a full .env, use it.
  process.env[key] ??= value;
}

type GoogleSheetsModule = typeof import('../services/google-sheets.service');
type VaultCryptoModule = typeof import('../services/vault-crypto');
type IntegrationsModule = typeof import('./integrations');

let sheetsService: GoogleSheetsModule;
let vaultCrypto: VaultCryptoModule;
let integrationsRoutes: IntegrationsModule['default'];

const USER_ID = '11111111-2222-3333-4444-555555555555';

interface Row {
  user_id: string;
  encrypted_token: string;
  google_email: string | null;
  sheet_id: string | null;
  sheet_url: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  revoke_pending_at: string | null;
  revoke_attempts: number;
  revoke_last_error: string | null;
}

interface Db {
  client: unknown;
  rows: Row[];
  deletes: string[];
  /** Ordered log of the operations that touched the credential table. */
  order: string[];
  /** FIX 2 — rows written to google_grant_orphans. */
  orphanInserts: Record<string, unknown>[];
}

/**
 * A google_integrations fake that ACTUALLY APPLIES `.eq` and `.is` filters.
 *
 * The shared fake in admin-writes.test.ts records filters without applying
 * them, which is right for its cases and useless here: half of what fix 1 does
 * is make getIntegration's `.is('revoke_pending_at', null)` hide a parked row,
 * and a fake that ignores the filter would report that as working no matter
 * what the code did.
 */
function fakeDb(seed: Row[], rec: { order: string[] }, orphanInsertFails = false): Db {
  const rows = [...seed];
  const deletes: string[] = [];
  const orphanInserts: Record<string, unknown>[] = [];

  const from = (table: string): Record<string, unknown> => {
    if (table === 'users') {
      // Only GET /integrations/google reads this, through resolveSheetsAccess.
      // A premium plan keeps entitlement out of the way — these cases are about
      // the credential row, not about who may connect.
      const u: Record<string, unknown> = {
        select: () => u,
        eq: () => u,
        maybeSingle: async () => ({
          data: {
            plan: 'premium',
            sheets_trial_activated_at: null,
            sheets_trial_expires_at: null,
            sheets_trial_revoked_at: null,
          },
          error: null,
        }),
      };
      return u;
    }
    if (table === 'google_grant_orphans') {
      // FIX 2's durable trail. Recorded, and optionally failed on demand.
      const o: Record<string, unknown> = {
        insert: async (values: Record<string, unknown>) => {
          rec.order.push(`orphan:${values.user_id}`);
          orphanInserts.push(values);
          return orphanInsertFails ? { error: { message: 'table unavailable' } } : { error: null };
        },
      };
      return o;
    }
    assert.equal(table, 'google_integrations');
    const filters: [string, unknown][] = [];
    let op: 'select' | 'update' | 'delete' | 'upsert' = 'select';
    let values: Record<string, unknown> = {};

    const matching = (): Row[] =>
      rows.filter((r) =>
        filters.every(([col, val]) => (r as unknown as Record<string, unknown>)[col] === val),
      );

    const builder: Record<string, unknown> = {
      select: () => builder,
      order: () => builder,
      limit: () => builder,
      not: () => builder,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return op === 'delete' || op === 'update' ? settleAsync() : builder;
      },
      is: (col: string, val: unknown) => {
        filters.push([col, val]);
        return builder;
      },
      update: (v: Record<string, unknown>) => {
        op = 'update';
        values = v;
        return builder;
      },
      upsert: (v: Record<string, unknown>) => {
        op = 'upsert';
        values = v;
        return settleAsync();
      },
      delete: () => {
        op = 'delete';
        return builder;
      },
      maybeSingle: async () => ({ data: matching()[0] ?? null, error: null }),
    };

    function settle(): { data: unknown; error: unknown } {
      const hit = matching();
      if (op === 'delete') {
        for (const r of hit) {
          deletes.push(r.user_id);
          rec.order.push(`delete:${r.user_id}`);
          rows.splice(rows.indexOf(r), 1);
        }
        return { data: null, error: null };
      }
      if (op === 'update') {
        for (const r of hit) {
          Object.assign(r, values);
          rec.order.push(`park:${r.user_id}`);
        }
        return { data: hit, error: null };
      }
      return { data: hit, error: null };
    }

    function settleAsync(): Promise<{ data: unknown; error: unknown }> & Record<string, unknown> {
      const p = Promise.resolve().then(settle) as Promise<{ data: unknown; error: unknown }> &
        Record<string, unknown>;
      return p;
    }

    builder.then = (resolve: (v: unknown) => unknown) => resolve(settle());
    return builder;
  };

  return { client: { from }, rows, deletes, order: rec.order, orphanInserts };
}

async function buildApp(db: Db): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate('supabase', db.client as never);
  app.decorate('redis', { set: async () => 'OK', get: async () => null } as never);
  app.decorate('authenticate', (async (request: { authUser: AuthUser | null }) => {
    request.authUser = { userId: USER_ID, lineUserId: 'U-test', sessionVersion: 1 };
  }) as never);
  await app.register(integrationsRoutes);
  await app.ready();
  return app;
}

async function seedRow(): Promise<Row> {
  const key = await vaultCrypto.deriveSecretKey(USER_ID);
  return {
    user_id: USER_ID,
    encrypted_token: vaultCrypto.encryptSecret(key, 'fake-refresh-token'),
    google_email: 'someone@example.test',
    sheet_id: null,
    sheet_url: null,
    last_synced_at: null,
    last_error: null,
    revoke_pending_at: null,
    revoke_attempts: 0,
    revoke_last_error: null,
  };
}

/** Stub Google's revoke endpoint. Returns the restore function. */
function stubRevoke(respond: () => Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = typeof url === 'string' ? url : url.toString();
    if (href.includes('oauth2.googleapis.com/revoke')) return respond();
    throw new Error(`unexpected fetch to ${href}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe('DELETE /integrations/google', () => {
  let restore: (() => void) | null = null;
  let app: FastifyInstance | null = null;

  before(async () => {
    sheetsService = await import('../services/google-sheets.service');
    vaultCrypto = await import('../services/vault-crypto');
    integrationsRoutes = (await import('./integrations')).default;
  });

  afterEach(async () => {
    restore?.();
    restore = null;
    await app?.close();
    app = null;
    sheetsService.__setRevokeColumnsSupportedForTests(true);
  });

  it('revokes at Google BEFORE deleting the credential row', async () => {
    const revokeCalls: number[] = [];
    restore = stubRevoke(() => {
      revokeCalls.push(1);
      return new Response('', { status: 200 });
    });

    const db = fakeDb([await seedRow()], { order: [] });
    app = await buildApp(db);

    const res = await app.inject({ method: 'DELETE', url: '/integrations/google' });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().success, true);
    assert.equal(revokeCalls.length, 1, 'the grant must be revoked at Google');
    assert.deepEqual(db.deletes, [USER_ID]);
    assert.equal(db.rows.length, 0);
  });

  it('does NOT delete the row when the Google revoke fails', async () => {
    // THE fix-1 regression test. Before the fix this deleted unconditionally and
    // the grant stayed alive at Google with nothing left able to revoke it.
    restore = stubRevoke(() => new Response('upstream boom', { status: 503 }));

    const db = fakeDb([await seedRow()], { order: [] });
    app = await buildApp(db);

    const res = await app.inject({ method: 'DELETE', url: '/integrations/google' });

    assert.deepEqual(db.deletes, [], 'the only copy of the refresh token must survive');
    assert.equal(db.rows.length, 1);
    assert.ok(db.rows[0]!.revoke_pending_at, 'the row must be parked for the retry pass');
    assert.equal(db.rows[0]!.revoke_attempts, 1);

    // And the user is NOT told it worked.
    assert.equal(res.statusCode, 202);
    const body = res.json();
    assert.equal(body.success, false);
    assert.equal(body.pending, true);
    assert.equal(body.code, 'DISCONNECT_REVOKE_PENDING');
  });

  it('reports the account as disconnected once the row is parked', async () => {
    // Parking is only honest if the disconnect is real from the user's side.
    // getIntegration filters parked rows out, so the status card — and both
    // sheetsWorker sync paths, which read through the same function — see no
    // integration at all.
    restore = stubRevoke(() => new Response('upstream boom', { status: 503 }));

    const db = fakeDb([await seedRow()], { order: [] });
    app = await buildApp(db);

    await app.inject({ method: 'DELETE', url: '/integrations/google' });
    const status = await app.inject({ method: 'GET', url: '/integrations/google' });

    assert.equal(status.json().connected, false);
  });

  it('a second disconnect while parked is a no-op, not a second revoke', async () => {
    let revokes = 0;
    restore = stubRevoke(() => {
      revokes += 1;
      return new Response('upstream boom', { status: 503 });
    });

    const db = fakeDb([await seedRow()], { order: [] });
    app = await buildApp(db);

    await app.inject({ method: 'DELETE', url: '/integrations/google' });
    const second = await app.inject({ method: 'DELETE', url: '/integrations/google' });

    assert.equal(revokes, 1, 'the parked row is invisible, so nothing is re-revoked here');
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().success, true);
    assert.deepEqual(db.deletes, [], 'and still nothing is deleted');
  });

  it('treats an already-invalid token as revoked and completes the delete', async () => {
    // Google answers 400 invalid_token when the user revoked us from their
    // account page. The grant IS gone; wedging the row forever over it would be
    // the wrong direction.
    restore = stubRevoke(
      () => new Response(JSON.stringify({ error: 'invalid_token' }), { status: 400 }),
    );

    const db = fakeDb([await seedRow()], { order: [] });
    app = await buildApp(db);

    const res = await app.inject({ method: 'DELETE', url: '/integrations/google' });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(db.deletes, [USER_ID]);
  });

  // FIX 2 — the token will not decrypt (VAULT_MASTER_KEY rotated). Nothing was
  // sent to Google and nothing ever can be, so the grant is live and
  // unrevocable. This used to be reported as a successful revoke and the row was
  // deleted, erasing the last trace of it.
  describe('when the stored token cannot be decrypted', () => {
    /** A syntactically valid but undecryptable ciphertext under the real key. */
    async function corruptRow(): Promise<Row> {
      const row = await seedRow();
      const other = await vaultCrypto.deriveSecretKey('a-different-user-entirely');
      return { ...row, encrypted_token: vaultCrypto.encryptSecret(other, 'fake-refresh-token') };
    }

    it('records the orphaned grant before deleting, and does not claim success', async () => {
      restore = stubRevoke(() => {
        throw new Error('must not reach Google — nothing could be decrypted to send');
      });

      const db = fakeDb([await corruptRow()], { order: [] });
      app = await buildApp(db);

      const res = await app.inject({ method: 'DELETE', url: '/integrations/google' });

      assert.deepEqual(
        db.order,
        [`orphan:${USER_ID}`, `delete:${USER_ID}`],
        'the durable record must exist before the row is destroyed',
      );
      assert.equal(db.orphanInserts.length, 1);
      assert.equal(db.orphanInserts[0]!.reason, 'decrypt_failed');
      assert.equal(db.orphanInserts[0]!.context, 'manual_disconnect');
      // The account email is the only thing that names WHICH Google account
      // still carries the grant, and its row is about to be deleted.
      assert.equal(db.orphanInserts[0]!.google_email, 'someone@example.test');

      const body = res.json();
      assert.equal(res.statusCode, 200);
      assert.equal(body.revoked, false, 'nothing was revoked and the response must say so');
      assert.equal(body.code, 'GRANT_NOT_REVOKED');
      assert.match(body.message, /myaccount\.google\.com/);
    });

    it('deletes nothing when the orphan record cannot be written', async () => {
      restore = stubRevoke(() => new Response('', { status: 200 }));

      const db = fakeDb([await corruptRow()], { order: [] }, true);
      app = await buildApp(db);

      const res = await app.inject({ method: 'DELETE', url: '/integrations/google' });

      assert.deepEqual(db.deletes, [], 'without a record, deleting loses the grant forever');
      assert.equal(db.rows.length, 1);
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().code, 'DISCONNECT_UNAVAILABLE');
    });
  });

  it('is idempotent when there is nothing connected', async () => {
    restore = stubRevoke(() => {
      throw new Error('must not revoke when there is no credential');
    });

    const db = fakeDb([], { order: [] });
    app = await buildApp(db);

    const res = await app.inject({ method: 'DELETE', url: '/integrations/google' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().success, true);
    assert.equal(res.json().revoked, false);
  });
});
