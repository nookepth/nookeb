import { describe, it, after, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AuthUser } from '../types';

/**
 * FIX 3 — GET /admin/sheets-trial and POST /admin/sheets-trial/:userId/force-expire.
 *
 * Two properties, both of which are about the admin surface not becoming a
 * second, weaker implementation of the sweep:
 *
 *   1. FORCE-EXPIRE GOES THROUGH cleanUpExpiredTrial. Ending a trial by hand in
 *      SQL — which was the only option before this endpoint — skips the upgrade
 *      check, the revoke-before-delete ordering, the orphan record and the
 *      claim column. The test asserts the observable consequences of each, so a
 *      future "simpler" implementation that writes the columns directly fails
 *      here rather than in production.
 *   2. IT CANNOT EXTEND A TRIAL. The cutoff may only ever move earlier; an
 *      admin route that could write a later expires_at would be a free plan
 *      grant, which is exactly what PATCH /admin/users/:id/plan is careful not
 *      to be.
 *
 * Plus the TIER 2 contract shared by every admin write: no audit row, no
 * action — and the audit comes FIRST here, because revoking someone's OAuth
 * grant cannot be undone.
 *
 * Config is supplied locally for the same reason as
 * integrations-disconnect.test.ts: these routes pull in modules that read
 * config at import time, and a skip-guard would mean the regression tests for
 * an irreversible admin action never run on a developer machine.
 */

const ADMIN_LINE_ID = 'U-admin-test';

for (const [key, value] of Object.entries({
  ADMIN_LINE_USER_IDS: ADMIN_LINE_ID,
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  VAULT_MASTER_KEY: '0'.repeat(63) + '1',
})) {
  process.env[key] = key === 'ADMIN_LINE_USER_IDS'
    ? [process.env[key], value].filter(Boolean).join(',')
    : (process.env[key] ?? value);
}

let adminOpsRoutes: (typeof import('./admin-ops'))['default'];
let vaultCrypto: typeof import('../services/vault-crypto');

/** A real, decryptable stored token — otherwise every revoke reads as a decrypt failure. */
async function realToken(userId = USER_ID): Promise<string> {
  const key = await vaultCrypto.deriveSecretKey(userId);
  return vaultCrypto.encryptSecret(key, 'fake-refresh-token');
}

const USER_ID = '11111111-2222-3333-4444-555555555555';
const NOW_ISH = () => new Date();

interface UserRow {
  id: string;
  line_user_id: string | null;
  plan: string | null;
  sheets_trial_activated_at: string | null;
  sheets_trial_expires_at: string | null;
  sheets_trial_revoked_at: string | null;
}

interface Rec {
  order: string[];
  userUpdates: Record<string, unknown>[];
  audits: Record<string, unknown>[];
  credentialDeletes: string[];
  orphanInserts: Record<string, unknown>[];
}

function blank(): Rec {
  return { order: [], userUpdates: [], audits: [], credentialDeletes: [], orphanInserts: [] };
}

/**
 * A Supabase fake over the four tables this endpoint touches. `.eq`/`.is`/`.gt`
 * filters on `users` are APPLIED, not merely recorded — the "cannot extend a
 * trial" guard IS a `.gt('sheets_trial_expires_at', now)` filter, so a fake that
 * ignored filters would report that guard as working no matter what.
 */
function fakeSupabase(
  users: UserRow[],
  credentials: Map<string, { encrypted_token: string; google_email: string | null }>,
  rec: Rec,
  opts: { auditFails?: boolean } = {},
) {
  const from = (table: string): Record<string, unknown> => {
    if (table === 'admin_audit_log') {
      return {
        insert: async (values: Record<string, unknown>) => {
          rec.order.push('audit');
          rec.audits.push(values);
          return opts.auditFails ? { error: { message: 'audit unavailable' } } : { error: null };
        },
      };
    }

    if (table === 'google_grant_orphans') {
      // insert = FIX 2's recorder; the select chain = summariseOrphanedGrants,
      // which GET /admin/sheets-trial reads for the orphan-backlog card.
      const o: Record<string, unknown> = {
        insert: async (values: Record<string, unknown>) => {
          rec.order.push('orphan');
          rec.orphanInserts.push(values);
          return { error: null };
        },
        select: () => o,
        is: () => o,
        gte: () => o,
        order: () => o,
        limit: () => o,
        maybeSingle: async () => ({ data: null, error: null, count: 0 }),
      };
      o.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: [], error: null, count: 0 });
      return o;
    }

    if (table === 'google_integrations') {
      let userId = '';
      let deleting = false;
      const b: Record<string, unknown> = {
        select: () => b,
        is: () => b,
        not: () => b,
        order: () => b,
        limit: async () => ({ data: [], error: null }),
        delete: () => {
          deleting = true;
          return b;
        },
        eq: (_c: string, v: string) => {
          userId = v;
          if (deleting) {
            rec.order.push(`delete-credential:${v}`);
            rec.credentialDeletes.push(v);
            credentials.delete(v);
            return Promise.resolve({ error: null });
          }
          return b;
        },
        maybeSingle: async () => ({ data: credentials.get(userId) ?? null, error: null }),
      };
      return b;
    }

    assert.equal(table, 'users');
    const filters: { op: string; col: string; val: unknown }[] = [];
    let op: 'select' | 'update' = 'select';
    let values: Record<string, unknown> = {};

    const matching = (): UserRow[] =>
      users.filter((u) =>
        filters.every(({ op: o, col, val }) => {
          const cur = (u as unknown as Record<string, unknown>)[col];
          if (o === 'eq') return cur === val;
          if (o === 'is') return cur === val;
          if (o === 'not-is') return cur !== val;
          if (o === 'gt') return String(cur ?? '') > String(val);
          if (o === 'lte') return String(cur ?? '') <= String(val);
          return true;
        }),
      );

    const b: Record<string, unknown> = {
      select: () => b,
      order: () => b,
      range: () => settle(),
      limit: () => settle(),
      eq: (col: string, val: unknown) => {
        filters.push({ op: 'eq', col, val });
        return b;
      },
      is: (col: string, val: unknown) => {
        filters.push({ op: 'is', col, val });
        return b;
      },
      gt: (col: string, val: unknown) => {
        filters.push({ op: 'gt', col, val });
        return b;
      },
      lte: (col: string, val: unknown) => {
        filters.push({ op: 'lte', col, val });
        return b;
      },
      not: (col: string, _op: string, val: unknown) => {
        filters.push({ op: 'not-is', col, val });
        return b;
      },
      update: (v: Record<string, unknown>) => {
        op = 'update';
        values = v;
        return b;
      },
      maybeSingle: async () => {
        const r = settleSync();
        return { data: (r.data as UserRow[])[0] ?? null, error: null, count: null };
      },
    };

    function settleSync(): { data: unknown; error: unknown; count: number | null } {
      const hit = matching();
      if (op === 'update') {
        rec.order.push('update-user');
        rec.userUpdates.push(values);
        for (const u of hit) Object.assign(u, values);
      }
      return { data: hit, error: null, count: hit.length };
    }
    function settle(): Promise<{ data: unknown; error: unknown; count: number | null }> {
      return Promise.resolve(settleSync());
    }

    b.then = (resolve: (v: unknown) => unknown) => resolve(settleSync());
    return b;
  };

  return { from };
}

async function buildApp(client: unknown, asLineUserId = ADMIN_LINE_ID): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate('supabase', client as never);
  app.decorate('redis', { get: async () => null, set: async () => 'OK', del: async () => 1 } as never);
  app.decorate('fileQueue', { getJob: async () => null } as never);
  app.decorate('authenticate', (async (request: { authUser: AuthUser | null }) => {
    request.authUser = { userId: 'u-admin', lineUserId: asLineUserId, sessionVersion: 1 };
  }) as never);
  await app.register(adminOpsRoutes);
  await app.ready();
  return app;
}

function activeTrial(overrides: Partial<UserRow> = {}): UserRow {
  const inTwoDays = new Date(Date.now() + 2 * 86_400_000).toISOString();
  return {
    id: USER_ID,
    line_user_id: 'U-someone',
    plan: 'free',
    sheets_trial_activated_at: new Date(Date.now() - 12 * 86_400_000).toISOString(),
    sheets_trial_expires_at: inTwoDays,
    sheets_trial_revoked_at: null,
    ...overrides,
  };
}

let restoreFetch: (() => void) | null = null;
function stubRevoke(respond: () => Response): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = typeof url === 'string' ? url : url.toString();
    if (href.includes('oauth2.googleapis.com/revoke')) return respond();
    // Anything else (a LINE push, say) is not what this suite is about.
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
  };
}

/**
 * Release the lazy Redis connections these routes open.
 *
 * force-expire's `cancelPendingSync` constructs the sheets QUEUE, and
 * pushMessage reads the push kill switch through push-flag.service — both hold
 * a real ioredis client open for the life of the process, so without this the
 * suite passes every assertion and then hangs forever on a live socket.
 */
async function releaseLazyConnections(): Promise<void> {
  const [sheetsQueue, pushFlag, flags] = await Promise.all([
    import('../services/sheetsQueue'),
    import('../services/push-flag.service'),
    import('../services/feature-flags.service'),
  ]);

  // Queue.close() does NOT disconnect a connection the caller supplied, and
  // sheetsQueue supplies its own createRedis() client — so the socket outlives
  // the queue and keeps the event loop alive. Grab it before closing.
  try {
    const client = await sheetsQueue.getSheetsQueue().client;
    await sheetsQueue.closeSheetsQueue();
    client.disconnect();
  } catch {
    // Never let teardown fail a passing suite.
  }
  await Promise.allSettled([pushFlag.closePushFlag(), flags.closeFeatureFlags()]);
}

describe('POST /admin/sheets-trial/:userId/force-expire', () => {
  let app: FastifyInstance | null = null;

  after(releaseLazyConnections);

  before(async () => {
    adminOpsRoutes = (await import('./admin-ops')).default;
    vaultCrypto = await import('../services/vault-crypto');
  });

  afterEach(async () => {
    restoreFetch?.();
    restoreFetch = null;
    await app?.close();
    app = null;
  });

  it('audits BEFORE it revokes, and revokes before deleting the credential', async () => {
    // The order is the whole contract for an irreversible admin action: a
    // failed audit must mean nothing happened, and a failed revoke must mean
    // the token survives.
    stubRevoke(() => new Response('', { status: 200 }));
    const rec = blank();
    const creds = new Map([[USER_ID, { encrypted_token: await realToken(), google_email: 'a@b.test' }]]);
    app = await buildApp(fakeSupabase([activeTrial()], creds, rec));

    const res = await app.inject({
      method: 'POST',
      url: `/admin/sheets-trial/${USER_ID}/force-expire`,
      payload: { reason: 'abuse' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().outcome, 'revoked');
    assert.equal(res.json().cleanupComplete, true);

    const auditAt = rec.order.indexOf('audit');
    const deleteAt = rec.order.indexOf(`delete-credential:${USER_ID}`);
    assert.ok(auditAt >= 0, 'the action must be audited');
    assert.ok(auditAt < deleteAt, 'audit must land before anything irreversible');
    assert.deepEqual(rec.credentialDeletes, [USER_ID]);
    assert.equal(rec.audits[0]!.action, 'sheets_trial_force_expire');
    assert.equal(rec.audits[0]!.target_id, USER_ID);
  });

  it('does nothing at all when the audit row cannot be written', async () => {
    stubRevoke(() => new Response('', { status: 200 }));
    const rec = blank();
    const creds = new Map([[USER_ID, { encrypted_token: await realToken(), google_email: null }]]);
    app = await buildApp(fakeSupabase([activeTrial()], creds, rec, { auditFails: true }));

    const res = await app.inject({
      method: 'POST',
      url: `/admin/sheets-trial/${USER_ID}/force-expire`,
      payload: {},
    });

    assert.equal(res.statusCode, 500);
    assert.deepEqual(rec.credentialDeletes, [], 'an unaudited revocation must not happen');
    assert.deepEqual(rec.userUpdates, [], 'and the cutoff must not have moved');
  });

  it('leaves the credential in place when Google is unreachable', async () => {
    // Reported honestly rather than as a success: the cutoff HAS moved (access
    // is gone) but the grant has not been handed back, and the 15-minute sweep
    // is what finishes it — the same path an ordinary expiry takes.
    stubRevoke(() => new Response('nope', { status: 503 }));
    const rec = blank();
    const creds = new Map([[USER_ID, { encrypted_token: await realToken(), google_email: null }]]);
    app = await buildApp(fakeSupabase([activeTrial()], creds, rec));

    const res = await app.inject({
      method: 'POST',
      url: `/admin/sheets-trial/${USER_ID}/force-expire`,
      payload: {},
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().outcome, 'deferred');
    assert.equal(res.json().cleanupComplete, false);
    assert.deepEqual(rec.credentialDeletes, [], 'the only copy of the token must survive');
  });

  it('never touches the credential of a user whose PLAN includes Sheets', async () => {
    // The property that hand-written SQL would have skipped: a trial user who
    // bought premium mid-trial still has a trial row, and revoking on that basis
    // destroys a paying customer's working connection.
    stubRevoke(() => {
      throw new Error('must not reach Google for a premium user');
    });
    const rec = blank();
    const creds = new Map([[USER_ID, { encrypted_token: await realToken(), google_email: null }]]);
    app = await buildApp(fakeSupabase([activeTrial({ plan: 'premium' })], creds, rec));

    const res = await app.inject({
      method: 'POST',
      url: `/admin/sheets-trial/${USER_ID}/force-expire`,
      payload: {},
    });

    assert.equal(res.json().outcome, 'keptOnPlan');
    assert.deepEqual(rec.credentialDeletes, []);
  });

  it('cannot EXTEND a trial — the cutoff only ever moves earlier', async () => {
    stubRevoke(() => new Response('', { status: 200 }));
    const rec = blank();
    const users = [activeTrial()];
    const originalExpiry = users[0]!.sheets_trial_expires_at!;
    app = await buildApp(fakeSupabase(users, new Map(), rec));

    await app.inject({
      method: 'POST',
      url: `/admin/sheets-trial/${USER_ID}/force-expire`,
      payload: {},
    });

    const written = users[0]!.sheets_trial_expires_at!;
    assert.ok(written < originalExpiry, 'the new cutoff must be earlier than the old one');
    assert.ok(written <= NOW_ISH().toISOString());
  });

  it('409s a trial the sweep has already cleaned up, without auditing', async () => {
    const rec = blank();
    app = await buildApp(
      fakeSupabase(
        [activeTrial({ sheets_trial_revoked_at: new Date().toISOString() })],
        new Map(),
        rec,
      ),
    );

    const res = await app.inject({
      method: 'POST',
      url: `/admin/sheets-trial/${USER_ID}/force-expire`,
      payload: {},
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'ALREADY_REVOKED');
    assert.deepEqual(rec.audits, [], 'no action, no audit row claiming one');
  });

  it('409s a user who never started a trial', async () => {
    const rec = blank();
    app = await buildApp(
      fakeSupabase(
        [
          activeTrial({
            sheets_trial_activated_at: null,
            sheets_trial_expires_at: null,
          }),
        ],
        new Map(),
        rec,
      ),
    );

    const res = await app.inject({
      method: 'POST',
      url: `/admin/sheets-trial/${USER_ID}/force-expire`,
      payload: {},
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'NO_TRIAL');
  });

  it('rejects a non-uuid user id before touching anything', async () => {
    const rec = blank();
    app = await buildApp(fakeSupabase([activeTrial()], new Map(), rec));

    const res = await app.inject({
      method: 'POST',
      url: '/admin/sheets-trial/not-a-uuid/force-expire',
      payload: {},
    });

    assert.equal(res.statusCode, 400);
    assert.deepEqual(rec.audits, []);
  });

  it('refuses a caller who is not on the admin allowlist', async () => {
    const rec = blank();
    app = await buildApp(fakeSupabase([activeTrial()], new Map(), rec), 'U-not-an-admin');

    const res = await app.inject({
      method: 'POST',
      url: `/admin/sheets-trial/${USER_ID}/force-expire`,
      payload: {},
    });

    assert.equal(res.statusCode, 403);
    assert.deepEqual(rec.audits, []);
    assert.deepEqual(rec.userUpdates, []);
  });
});

describe('GET /admin/sheets-trial', () => {
  let app: FastifyInstance | null = null;

  before(async () => {
    adminOpsRoutes = (await import('./admin-ops')).default;
    vaultCrypto = await import('../services/vault-crypto');
  });

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('defaults to the expired backlog — the one list that means work to do', async () => {
    const rec = blank();
    app = await buildApp(fakeSupabase([activeTrial()], new Map(), rec));
    const res = await app.inject({ method: 'GET', url: '/admin/sheets-trial' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'expired');
  });

  it('accepts the three real statuses and ignores anything else', async () => {
    const rec = blank();
    app = await buildApp(fakeSupabase([activeTrial()], new Map(), rec));
    // Bound to a local so tsc does not have to resolve `app`'s nullable type
    // through the loop (it reports TS7022 circularity when it does).
    const server: FastifyInstance = app;
    for (const status of ['active', 'revoked'] as const) {
      const one = await server.inject({ method: 'GET', url: `/admin/sheets-trial?status=${status}` });
      assert.equal(one.json().status, status);
    }
    const bogus = await app.inject({ method: 'GET', url: '/admin/sheets-trial?status=whatever' });
    assert.equal(bogus.json().status, 'expired');
  });

  it('clamps pagination rather than trusting the query string', async () => {
    const rec = blank();
    app = await buildApp(fakeSupabase([activeTrial()], new Map(), rec));

    const huge = await app.inject({ method: 'GET', url: '/admin/sheets-trial?limit=100000' });
    assert.equal(huge.json().limit, 200);

    const negative = await app.inject({
      method: 'GET',
      url: '/admin/sheets-trial?limit=-5&offset=-9',
    });
    assert.equal(negative.json().limit, 1);
    assert.equal(negative.json().offset, 0);
  });

  it('refuses a non-admin', async () => {
    const rec = blank();
    app = await buildApp(fakeSupabase([activeTrial()], new Map(), rec), 'U-not-an-admin');
    const res = await app.inject({ method: 'GET', url: '/admin/sheets-trial' });
    assert.equal(res.statusCode, 403);
  });
});
