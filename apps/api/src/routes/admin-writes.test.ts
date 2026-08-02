import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import adminRoutes from './admin';
import type { AuthUser } from '../types';

/**
 * TIER 2 admin WRITES, exercised end to end through a real Fastify instance —
 * validation, the admin gate, the DB calls and the audit row.
 *
 * Two of these endpoints are the ones most likely to be reached for in an
 * incident and least likely to be exercised by hand afterwards:
 *
 *   PATCH  /admin/users/:id/plan             grants a paid entitlement outright
 *   POST   /admin/users/:id/revoke-sessions  kicks someone out of every session
 *
 * A real Fastify app rather than calling the handler directly, because half of
 * what is being asserted lives in the framework layer: registerAdminGuard's two
 * preHandlers, the zod 400, and the JSON body parse. Calling the handler
 * function would skip exactly the parts that decide who is allowed in.
 *
 * NOTE: this file imports modules that read config at import time, so the suite
 * must run with `--env-file=../../.env` (same as the security tests). The admin
 * id is read from ADMIN_LINE_USER_IDS rather than hardcoded — the allowlist is
 * the only definition of "admin" (CLAUDE.md §13), and pinning a real person's
 * LINE id into a test file would be both brittle and wrong.
 */

const ADMIN_LINE_ID = (process.env.ADMIN_LINE_USER_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)[0];

/** Without an allowlist entry the guard 403s everything and nothing below is meaningful. */
const skip = ADMIN_LINE_ID ? false : 'ADMIN_LINE_USER_IDS is empty — cannot exercise the admin gate';

// ---------------------------------------------------------------------------
// A chainable Supabase fake.
//
// Filters are recorded but not applied: each test seeds ONE row per table, so
// "every row of the table" is the right answer to every query. What matters is
// the OP and the VALUES, which is what the assertions read.
// ---------------------------------------------------------------------------

interface DbCall {
  table: string;
  op: 'select' | 'update' | 'insert';
  values: Record<string, unknown>;
  filters: [string, unknown][];
}

interface FakeDb {
  client: unknown;
  calls: DbCall[];
  updates: (table: string) => Record<string, unknown>[];
  inserts: (table: string) => Record<string, unknown>[];
}

function fakeSupabase(
  tables: Record<string, Record<string, unknown>[]>,
  failures: { insertFails?: string } = {},
): FakeDb {
  const calls: DbCall[] = [];

  const from = (table: string): Record<string, unknown> => {
    const state = {
      op: 'select' as DbCall['op'],
      values: {} as Record<string, unknown>,
      filters: [] as [string, unknown][],
      single: false,
    };
    const builder: Record<string, unknown> = {};

    const chain = (name: string): void => {
      builder[name] = (...args: unknown[]) => {
        if (name === 'update') {
          state.op = 'update';
          state.values = args[0] as Record<string, unknown>;
        }
        if (name === 'insert') {
          state.op = 'insert';
          state.values = args[0] as Record<string, unknown>;
        }
        if (name === 'eq' || name === 'is' || name === 'in') {
          state.filters.push([String(args[0]), args[1]]);
        }
        if (name === 'maybeSingle' || name === 'single') state.single = true;
        return builder;
      };
    };
    // The full chain surface reachable from these routes, including the
    // lazily-imported boost.service (`.gt`) that reconcileBoostsForPlan pulls
    // in. A missing method here surfaces as a 500, not a helpful error, so the
    // list is deliberately generous.
    [
      'select',
      'eq',
      'neq',
      'is',
      'in',
      'gt',
      'gte',
      'lt',
      'lte',
      'not',
      'order',
      'limit',
      'range',
      'update',
      'insert',
      'upsert',
      'delete',
      'maybeSingle',
      'single',
    ].forEach(chain);

    const settle = (): { data: unknown; error: unknown } => {
      calls.push({ table, op: state.op, values: state.values, filters: state.filters });
      if (state.op === 'insert') {
        return failures.insertFails === table
          ? { data: null, error: { message: 'audit table unavailable' } }
          : { data: null, error: null };
      }
      const rows = tables[table] ?? [];
      if (state.op === 'update') {
        // Mimic PostgREST: an UPDATE ... RETURNING gives back the rows it hit,
        // already carrying the new values.
        const hit = rows.map((r) => ({ ...r, ...state.values }));
        return { data: state.single ? (hit[0] ?? null) : hit, error: null };
      }
      return { data: state.single ? (rows[0] ?? null) : rows, error: null };
    };

    builder.then = (resolve: (v: unknown) => unknown) => resolve(settle());
    return builder;
  };

  return {
    client: { from },
    calls,
    updates: (table) => calls.filter((c) => c.table === table && c.op === 'update').map((c) => c.values),
    inserts: (table) => calls.filter((c) => c.table === table && c.op === 'insert').map((c) => c.values),
  };
}

/**
 * A Fastify app with routes/admin.ts registered and every decoration stubbed.
 *
 * `authenticate` stands in for the JWT middleware and populates authUser with
 * the allowlisted admin id; the SECOND preHandler that registerAdminGuard adds
 * (isAdminLineUser) is the real one and is what the "non-admin is refused" test
 * exercises.
 */
async function buildApp(db: FakeDb, asLineUserId: string = ADMIN_LINE_ID!): Promise<FastifyInstance> {
  const app = Fastify();
  const deleted: string[] = [];
  app.decorate('supabase', db.client as never);
  app.decorate('redis', { del: async (k: string) => void deleted.push(k) } as never);
  app.decorate('fileQueue', {} as never);
  app.decorate('r2', {} as never);
  app.decorate('authenticate', (async (request: { authUser: AuthUser | null }) => {
    request.authUser = { userId: 'u-admin', lineUserId: asLineUserId, sessionVersion: 1 };
  }) as never);
  (app as unknown as { __cacheDeletes: string[] }).__cacheDeletes = deleted;
  await app.register(adminRoutes);
  await app.ready();
  return app;
}

const USER_ID = '11111111-2222-3333-4444-555555555555';

// ---------------------------------------------------------------------------

describe('PATCH /admin/users/:id/plan', { skip }, () => {
  let app: FastifyInstance;
  after(async () => {
    await app?.close();
  });

  it('rejects a plan value that is not in the allowlist', async () => {
    const db = fakeSupabase({ users: [{ id: USER_ID, plan: 'free', session_version: 1 }] });
    app = await buildApp(db);

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${USER_ID}/plan`,
      payload: { plan: 'enterprise' },
    });

    assert.equal(res.statusCode, 400);
    // Nothing may reach the DB — a rejected body must not half-apply.
    assert.deepEqual(db.updates('users'), []);
    assert.deepEqual(db.inserts('admin_audit_log'), []);
    await app.close();
  });

  it('rejects a missing plan field, an empty body, and a non-string plan', async () => {
    const db = fakeSupabase({ users: [{ id: USER_ID, plan: 'free' }] });
    app = await buildApp(db);

    for (const payload of [{}, { plan: null }, { plan: 3 }, { plan: '' }, { plan: 'PRO' }]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/users/${USER_ID}/plan`,
        payload,
      });
      assert.equal(res.statusCode, 400, `payload ${JSON.stringify(payload)} should be rejected`);
    }
    assert.deepEqual(db.updates('users'), []);
    await app.close();
  });

  it("accepts the legacy raw value 'team' without normalising it away", async () => {
    // migration 051's CHECK still permits 'team' and normalizePlan folds it onto
    // premium. Rejecting it would make an existing row un-editable; rewriting it
    // to 'premium' silently would be a data change the admin did not ask for.
    const db = fakeSupabase({
      users: [{ id: USER_ID, plan: 'free', referral_count: 0, storage_limit: 1024, storage_limit_override: null }],
      user_group_boosts: [],
    });
    app = await buildApp(db);

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${USER_ID}/plan`,
      payload: { plan: 'team' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as { plan: string; normalizedPlan: string; changed: boolean };
    assert.equal(body.plan, 'team');
    assert.equal(body.normalizedPlan, 'premium');
    assert.equal(body.changed, true);
    await app.close();
  });

  it('records an audit row carrying the previous and the new plan', async () => {
    const db = fakeSupabase({
      users: [{ id: USER_ID, plan: 'free', referral_count: 0, storage_limit: 1024, storage_limit_override: null }],
      user_group_boosts: [],
    });
    app = await buildApp(db);

    await app.inject({ method: 'PATCH', url: `/admin/users/${USER_ID}/plan`, payload: { plan: 'pro' } });

    const audits = db.inserts('admin_audit_log');
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.action, 'user_plan_change');
    assert.equal(audits[0]!.admin_line_id, ADMIN_LINE_ID);
    assert.equal(audits[0]!.target_type, 'user');
    assert.equal(audits[0]!.target_id, USER_ID);
    assert.equal((audits[0]!.before as { plan: string }).plan, 'free');
    assert.equal((audits[0]!.after as { plan: string }).plan, 'pro');
    await app.close();
  });

  it('is idempotent: re-setting the plan a user already has writes nothing', async () => {
    const db = fakeSupabase({
      users: [{ id: USER_ID, plan: 'pro', referral_count: 0, storage_limit: 1024, storage_limit_override: null }],
    });
    app = await buildApp(db);

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${USER_ID}/plan`,
      payload: { plan: 'pro' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { changed: boolean }).changed, false);
    assert.deepEqual(db.updates('users'), []);
    await app.close();
  });

  it('500s and REVERTS the plan when the audit insert fails', async () => {
    // The fail-safe rule: a privileged write that could not be recorded must not
    // survive. The last users update must put the original plan back.
    const db = fakeSupabase(
      {
        users: [{ id: USER_ID, plan: 'free', referral_count: 0, storage_limit: 1024, storage_limit_override: null }],
        user_group_boosts: [],
      },
      { insertFails: 'admin_audit_log' },
    );
    app = await buildApp(db);

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${USER_ID}/plan`,
      payload: { plan: 'premium' },
    });

    assert.equal(res.statusCode, 500);
    const userUpdates = db.updates('users');
    assert.ok(userUpdates.length >= 2, 'expected the write and then its revert');
    assert.equal(userUpdates.at(-1)!.plan, 'free');
    assert.equal(userUpdates.at(-1)!.storage_limit, 1024);
    await app.close();
  });

  it('403s a caller who is not on the ADMIN_LINE_USER_IDS allowlist', async () => {
    const db = fakeSupabase({ users: [{ id: USER_ID, plan: 'free' }] });
    app = await buildApp(db, 'Unot-an-admin-at-all');

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${USER_ID}/plan`,
      payload: { plan: 'premium' },
    });

    assert.equal(res.statusCode, 403);
    assert.deepEqual(db.updates('users'), []);
    await app.close();
  });
});

describe('POST /admin/users/:id/revoke-sessions', { skip }, () => {
  let app: FastifyInstance;
  after(async () => {
    await app?.close();
  });

  it('increments users.session_version by exactly one', async () => {
    const db = fakeSupabase({ users: [{ id: USER_ID, session_version: 4 }] });
    app = await buildApp(db);

    const res = await app.inject({ method: 'POST', url: `/admin/users/${USER_ID}/revoke-sessions` });

    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { sessionVersion: number }).sessionVersion, 5);
    assert.equal(db.updates('users')[0]!.session_version, 5);
    await app.close();
  });

  it('treats a pre-migration-009 row (no session_version) as 1 and writes 2', async () => {
    const db = fakeSupabase({ users: [{ id: USER_ID }] });
    app = await buildApp(db);

    const res = await app.inject({ method: 'POST', url: `/admin/users/${USER_ID}/revoke-sessions` });

    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { sessionVersion: number }).sessionVersion, 2);
    await app.close();
  });

  it('guards the UPDATE on the version it read, so a concurrent bump cannot be lost', async () => {
    const db = fakeSupabase({ users: [{ id: USER_ID, session_version: 7 }] });
    app = await buildApp(db);

    await app.inject({ method: 'POST', url: `/admin/users/${USER_ID}/revoke-sessions` });

    const update = db.calls.find((c) => c.table === 'users' && c.op === 'update');
    assert.ok(update, 'expected an update on users');
    assert.ok(
      update!.filters.some(([col, val]) => col === 'session_version' && val === 7),
      'the UPDATE must carry .eq("session_version", <value read>) — without it two admins both reading 7 would both write 8 and one revocation would silently vanish',
    );
    await app.close();
  });

  it("busts the auth middleware's 60s session_version cache", async () => {
    // Without this the revocation appears not to work for up to a minute —
    // precisely when an admin is watching to confirm it did.
    const db = fakeSupabase({ users: [{ id: USER_ID, session_version: 1 }] });
    app = await buildApp(db);

    await app.inject({ method: 'POST', url: `/admin/users/${USER_ID}/revoke-sessions` });

    const deletes = (app as unknown as { __cacheDeletes: string[] }).__cacheDeletes;
    assert.ok(deletes.includes(`sv:${USER_ID}`), `expected sv:${USER_ID} to be deleted, got ${deletes.join(',')}`);
    await app.close();
  });

  it('404s an unknown user without writing anything', async () => {
    const db = fakeSupabase({ users: [] });
    app = await buildApp(db);

    const res = await app.inject({ method: 'POST', url: `/admin/users/${USER_ID}/revoke-sessions` });

    assert.equal(res.statusCode, 404);
    assert.deepEqual(db.updates('users'), []);
    await app.close();
  });

  it('records an audit row with both version numbers', async () => {
    const db = fakeSupabase({ users: [{ id: USER_ID, session_version: 9 }] });
    app = await buildApp(db);

    await app.inject({ method: 'POST', url: `/admin/users/${USER_ID}/revoke-sessions` });

    const audits = db.inserts('admin_audit_log');
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.action, 'user_revoke_sessions');
    assert.deepEqual(audits[0]!.before, { sessionVersion: 9 });
    assert.deepEqual(audits[0]!.after, { sessionVersion: 10 });
    await app.close();
  });

  it('500s and rolls the version back when the audit insert fails', async () => {
    const db = fakeSupabase({ users: [{ id: USER_ID, session_version: 3 }] }, { insertFails: 'admin_audit_log' });
    app = await buildApp(db);

    const res = await app.inject({ method: 'POST', url: `/admin/users/${USER_ID}/revoke-sessions` });

    assert.equal(res.statusCode, 500);
    const updates = db.updates('users');
    assert.equal(updates.at(-1)!.session_version, 3, 'the revert must restore the version that was read');
    await app.close();
  });
});

describe('admin write bodies are zod-validated before any DB call', { skip }, () => {
  let app: FastifyInstance;
  after(async () => {
    await app?.close();
  });

  it('rejects a storage override above the 1 TiB ceiling and below zero', async () => {
    const db = fakeSupabase({ users: [{ id: USER_ID, plan: 'free', storage_limit: 1024 }] });
    app = await buildApp(db);

    for (const bytes of [-1, 1_099_511_627_777, 1.5, 'lots']) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/users/${USER_ID}/storage-override`,
        payload: { bytes },
      });
      assert.equal(res.statusCode, 400, `bytes=${bytes} should be rejected`);
    }
    // null IS valid — it is how an override is removed.
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${USER_ID}/storage-override`,
      payload: { bytes: null },
    });
    assert.equal(cleared.statusCode, 200);
    assert.deepEqual(db.updates('users')[0]!.storage_limit_override, null);
    await app.close();
  });

  it('rejects an unknown quota feature', async () => {
    const db = fakeSupabase({ user_quotas: [] });
    app = await buildApp(db);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/users/${USER_ID}/quotas/not_a_feature/reset`,
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  it('404s a quota reset when no row exists for the current period', async () => {
    // A missing row already means "0 used" — creating one would be a write that
    // changes nothing while reporting success.
    const db = fakeSupabase({ user_quotas: [] });
    app = await buildApp(db);

    const res = await app.inject({ method: 'POST', url: `/admin/users/${USER_ID}/quotas/scans/reset` });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(db.updates('user_quotas'), []);
    await app.close();
  });
});

before(() => {
  if (skip) console.warn(`[admin-writes.test] skipped: ${skip}`);
});
