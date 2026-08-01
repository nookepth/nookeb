import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  alreadyWrittenToday,
  bangkokDate,
  bangkokHour,
  cancelSubscription,
  computeExpiry,
  createSubscription,
  getAddonStatus,
  getNotifyTime,
  getSubscription,
  isActiveSubscriber,
  isSubscriptionLive,
  isValidNotifyTime,
  listDueSubscribers,
  logSent,
  logSkipped,
  setNotifyTime,
  InvalidNotifyTimeError,
  type DiaryAddonSubscriptionRecord,
} from './diaryAddon.service';

/**
 * หนูเก็บความทรงจำ data access, against an in-memory PostgREST-shaped fake.
 *
 * Same reasoning as vault.service.test.ts: what matters is the FILTER CHAIN and
 * the constraint behaviour, not the network. Three properties here are the ones
 * that would cost real money or real trust if they broke —
 *
 *   - isSubscriptionLive must require status AND expiry (one alone either cuts
 *     off a payer early or keeps nudging a lapsed one);
 *   - UNIQUE(user_id, date) on the log must surface as `deduped`, because that
 *     row is the sweep's once-a-day guard, not an error;
 *   - createSubscription must UPSERT, because migration 052 allows exactly one
 *     row per user forever.
 *
 * so the fake enforces the unique constraints for real rather than accepting
 * every insert.
 */

interface LogRow {
  id: string;
  user_id: string;
  sent_at: string;
  skipped: boolean;
  skip_reason: string | null;
  date: string;
}

interface DiaryEntryRow {
  id: string;
  user_id: string;
  entry_date: string;
  deleted_at: string | null;
}

type Filter = { op: string; column: string; value: unknown };

interface FakeState {
  subs: DiaryAddonSubscriptionRecord[];
  logs: LogRow[];
  entries: DiaryEntryRow[];
}

const UNIQUE_VIOLATION = { code: '23505', message: 'duplicate key value' };

/** Minimal PostgREST-shaped fake that actually applies the filter chain. */
function fakeSupabase(state: FakeState) {
  let seq = 0;
  const nextId = () => `id-${++seq}`;

  function tableRows(table: string): Record<string, unknown>[] {
    switch (table) {
      case 'diary_addon_subscriptions':
        return state.subs as unknown as Record<string, unknown>[];
      case 'diary_addon_logs':
        return state.logs as unknown as Record<string, unknown>[];
      case 'diary_entries':
        return state.entries as unknown as Record<string, unknown>[];
      default:
        throw new Error(`unexpected table ${table}`);
    }
  }

  function makeQuery(table: string, mode: 'select' | 'update', patch?: Record<string, unknown>) {
    const filters: Filter[] = [];
    let limit = Infinity;

    const matches = (row: Record<string, unknown>): boolean =>
      filters.every((f) => {
        const cell = row[f.column];
        switch (f.op) {
          case 'eq':
            return cell === f.value;
          case 'is':
            return cell === f.value;
          case 'in':
            return (f.value as unknown[]).includes(cell);
          case 'gt':
            return String(cell) > String(f.value);
          case 'gte':
            return String(cell) >= String(f.value);
          case 'lte':
            return String(cell) <= String(f.value);
          default:
            throw new Error(`unhandled op ${f.op}`);
        }
      });

    const settle = () => {
      const hit = tableRows(table).filter(matches).slice(0, limit);
      if (mode === 'update') for (const row of hit) Object.assign(row, patch);
      return { data: hit.map((r) => ({ ...r })), error: null as unknown };
    };

    const api = {
      eq(column: string, value: unknown) {
        filters.push({ op: 'eq', column, value });
        return api;
      },
      is(column: string, value: unknown) {
        filters.push({ op: 'is', column, value });
        return api;
      },
      in(column: string, value: unknown[]) {
        filters.push({ op: 'in', column, value });
        return api;
      },
      gt(column: string, value: unknown) {
        filters.push({ op: 'gt', column, value });
        return api;
      },
      gte(column: string, value: unknown) {
        filters.push({ op: 'gte', column, value });
        return api;
      },
      lte(column: string, value: unknown) {
        filters.push({ op: 'lte', column, value });
        return api;
      },
      limit(n: number) {
        limit = n;
        return api;
      },
      select() {
        return api;
      },
      maybeSingle() {
        const res = settle();
        return Promise.resolve({ data: res.data[0] ?? null, error: null });
      },
      single() {
        const res = settle();
        return Promise.resolve({ data: res.data[0] ?? null, error: null });
      },
      then(resolve: (v: ReturnType<typeof settle>) => unknown) {
        return Promise.resolve(settle()).then(resolve);
      },
    };
    return api;
  }

  return {
    from(table: string) {
      return {
        select: () => makeQuery(table, 'select'),
        update: (patch: Record<string, unknown>) => makeQuery(table, 'update', patch),

        // INSERT enforces the real unique constraints, because "does a duplicate
        // come back as 23505" is the whole point of the log-dedup tests.
        insert(values: Record<string, unknown>) {
          if (table === 'diary_addon_logs') {
            const clash = state.logs.some(
              (l) => l.user_id === values.user_id && l.date === values.date,
            );
            if (clash) return Promise.resolve({ data: null, error: UNIQUE_VIOLATION });
            state.logs.push({ id: nextId(), ...(values as unknown as Omit<LogRow, 'id'>) });
            return Promise.resolve({ data: null, error: null });
          }
          throw new Error(`unexpected insert into ${table}`);
        },

        upsert(values: Record<string, unknown>) {
          if (table !== 'diary_addon_subscriptions') throw new Error('unexpected upsert');
          const existing = state.subs.find((s) => s.user_id === values.user_id);
          let row: DiaryAddonSubscriptionRecord;
          if (existing) {
            row = Object.assign(existing, values);
          } else {
            // Column defaults from migration 052 apply only to a fresh row.
            row = {
              ...sub({ id: nextId(), notify_time: '20:00:00' }),
              ...(values as Partial<DiaryAddonSubscriptionRecord>),
            };
            state.subs.push(row);
          }
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { ...row }, error: null }),
            }),
          };
        },
      };
    },
  } as unknown as SupabaseClient;
}

function sub(over: Partial<DiaryAddonSubscriptionRecord> = {}): DiaryAddonSubscriptionRecord {
  return {
    id: 'sub-1',
    user_id: 'u1',
    status: 'active',
    billing_cycle: 'monthly',
    price_thb: 49,
    started_at: '2026-08-01T00:00:00.000Z',
    expires_at: '2026-09-01T00:00:00.000Z',
    cancelled_at: null,
    notify_time: '20:00:00',
    created_at: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

/** The single log row, asserted to exist. */
function onlyLog(): LogRow {
  const row = state.logs[0];
  assert.ok(row, 'expected exactly one log row');
  return row;
}

/** The single subscription row, asserted to exist — keeps the tests total. */
function onlySub(): DiaryAddonSubscriptionRecord {
  const row = state.subs[0];
  assert.ok(row, 'expected exactly one subscription row');
  return row;
}

let state: FakeState;
let db: SupabaseClient;

beforeEach(() => {
  state = { subs: [], logs: [], entries: [] };
  db = fakeSupabase(state);
});

// ---------------------------------------------------------------------------

describe('Bangkok time helpers', () => {
  it('rolls the date over at 17:00 UTC, not at UTC midnight', () => {
    // 2026-08-01T16:59Z is still 31 July… no — 23:59 ICT on the 1st.
    assert.equal(bangkokDate(new Date('2026-08-01T16:59:00Z')), '2026-08-01');
    assert.equal(bangkokDate(new Date('2026-08-01T17:00:00Z')), '2026-08-02');
  });

  it('reports the Bangkok hour the sweep matches on', () => {
    assert.equal(bangkokHour(new Date('2026-08-01T13:05:00Z')), 20);
    assert.equal(bangkokHour(new Date('2026-08-01T17:30:00Z')), 0);
  });
});

describe('isValidNotifyTime', () => {
  it('accepts the whole legal range', () => {
    assert.equal(isValidNotifyTime('00:00'), true);
    assert.equal(isValidNotifyTime('23:59'), true);
    assert.equal(isValidNotifyTime('20:00'), true);
  });

  it('rejects out-of-range and malformed values', () => {
    for (const bad of ['24:00', '20:60', '7:00', '20:0', '2000', '', 'ยี่สิบ']) {
      assert.equal(isValidNotifyTime(bad), false, bad);
    }
  });
});

describe('computeExpiry', () => {
  it('adds one month for the monthly cycle', () => {
    const out = computeExpiry('monthly', new Date('2026-08-01T10:00:00Z'));
    assert.equal(out.toISOString(), '2026-09-01T10:00:00.000Z');
  });

  it('adds one year for the yearly cycle', () => {
    const out = computeExpiry('yearly', new Date('2026-08-01T10:00:00Z'));
    assert.equal(out.toISOString(), '2027-08-01T10:00:00.000Z');
  });

  it('clamps a month-end date instead of overflowing into the next month', () => {
    // 31 Jan + 1 month must be 28 Feb, not 3 March — matching Postgres
    // NOW() + INTERVAL '1 month'. Naive setMonth() gets this wrong.
    const out = computeExpiry('monthly', new Date('2026-01-31T09:00:00Z'));
    assert.equal(out.toISOString(), '2026-02-28T09:00:00.000Z');
  });

  it('clamps 29 Feb + 1 year to 28 Feb', () => {
    const out = computeExpiry('yearly', new Date('2028-02-29T09:00:00Z'));
    assert.equal(out.toISOString(), '2029-02-28T09:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------

describe('isSubscriptionLive', () => {
  const now = new Date('2026-08-15T00:00:00Z');

  it('is false with no subscription at all', () => {
    assert.equal(isSubscriptionLive(null, now), false);
  });

  it('is true for an active, unexpired row', () => {
    assert.equal(isSubscriptionLive(sub(), now), true);
  });

  it('is false once an active row is past expires_at', () => {
    // The lapsed case no expiry job has swept yet — status alone would say yes.
    assert.equal(isSubscriptionLive(sub({ expires_at: '2026-08-01T00:00:00Z' }), now), false);
  });

  it('is false for a cancelled row even before expiry', () => {
    assert.equal(isSubscriptionLive(sub({ status: 'cancelled' }), now), false);
  });

  it('is false for an expired row', () => {
    assert.equal(isSubscriptionLive(sub({ status: 'expired' }), now), false);
  });
});

describe('getSubscription / getAddonStatus / isActiveSubscriber', () => {
  const now = new Date('2026-08-15T00:00:00Z');

  it('returns null and inactive for a user who never bought', async () => {
    assert.equal(await getSubscription(db, 'nobody'), null);
    assert.deepEqual(await getAddonStatus(db, 'nobody', now), {
      active: false,
      subscription: null,
    });
    assert.equal(await isActiveSubscriber(db, 'nobody', now), false);
  });

  it('never returns another user’s row', async () => {
    state.subs.push(sub({ user_id: 'u1' }));
    assert.equal(await getSubscription(db, 'u2'), null);
    assert.equal(await isActiveSubscriber(db, 'u2', now), false);
  });

  it('reports an active holder', async () => {
    state.subs.push(sub());
    const status = await getAddonStatus(db, 'u1', now);
    assert.equal(status.active, true);
    assert.equal(status.subscription?.billing_cycle, 'monthly');
    assert.equal(await isActiveSubscriber(db, 'u1', now), true);
  });

  it('returns the row but active:false for a cancelled holder', async () => {
    // The UI still needs the row — it renders "ใช้ได้ถึง …".
    state.subs.push(sub({ status: 'cancelled', cancelled_at: '2026-08-10T00:00:00Z' }));
    const status = await getAddonStatus(db, 'u1', now);
    assert.equal(status.active, false);
    assert.equal(status.subscription?.status, 'cancelled');
  });
});

describe('createSubscription', () => {
  const now = new Date('2026-08-01T10:00:00Z');

  it('records an active monthly row at the config price', async () => {
    const row = await createSubscription(db, 'u1', 'monthly', now);
    assert.equal(row.status, 'active');
    assert.equal(row.billing_cycle, 'monthly');
    assert.equal(row.price_thb, 49);
    assert.equal(row.expires_at, '2026-09-01T10:00:00.000Z');
    assert.equal(state.subs.length, 1);
  });

  it('records a yearly row at the yearly price', async () => {
    const row = await createSubscription(db, 'u1', 'yearly', now);
    assert.equal(row.price_thb, 365);
    assert.equal(row.expires_at, '2027-08-01T10:00:00.000Z');
  });

  it('revives the SAME row on resubscribe and keeps the chosen notify time', async () => {
    // migration 052 allows exactly one row per user forever, so a second buy
    // must upsert — a second INSERT would violate uq_diary_addon_user.
    state.subs.push(
      sub({ status: 'cancelled', cancelled_at: '2026-07-20T00:00:00Z', notify_time: '07:30:00' }),
    );
    const row = await createSubscription(db, 'u1', 'yearly', now);
    assert.equal(state.subs.length, 1);
    assert.equal(row.status, 'active');
    assert.equal(row.cancelled_at, null);
    assert.equal(row.notify_time, '07:30:00');
  });
});

describe('cancelSubscription', () => {
  const now = new Date('2026-08-15T00:00:00Z');

  it('marks the row cancelled without deleting it', async () => {
    state.subs.push(sub());
    const row = await cancelSubscription(db, 'u1', now);
    assert.equal(row?.status, 'cancelled');
    assert.equal(row?.cancelled_at, now.toISOString());
    assert.equal(state.subs.length, 1);
    // Access continues to expiry — cancel is "do not renew".
    assert.equal(onlySub().expires_at, '2026-09-01T00:00:00.000Z');
  });

  it('returns null when there is nothing active to cancel', async () => {
    assert.equal(await cancelSubscription(db, 'u1', now), null);
  });

  it('does not overwrite the original cancelled_at on a second cancel', async () => {
    state.subs.push(sub());
    await cancelSubscription(db, 'u1', new Date('2026-08-10T00:00:00Z'));
    const second = await cancelSubscription(db, 'u1', now);
    assert.equal(second, null);
    assert.equal(onlySub().cancelled_at, '2026-08-10T00:00:00.000Z');
  });

  it('never cancels another user’s subscription', async () => {
    state.subs.push(sub({ user_id: 'u1' }));
    assert.equal(await cancelSubscription(db, 'u2', now), null);
    assert.equal(onlySub().status, 'active');
  });
});

describe('getNotifyTime / setNotifyTime', () => {
  it('returns the stored time as HH:MM', async () => {
    state.subs.push(sub({ notify_time: '07:05:00' }));
    assert.equal(await getNotifyTime(db, 'u1'), '07:05');
  });

  it('returns null for a user with no subscription', async () => {
    assert.equal(await getNotifyTime(db, 'u1'), null);
  });

  it('updates the time and stores it with seconds', async () => {
    state.subs.push(sub());
    assert.equal(await setNotifyTime(db, 'u1', '06:45'), '06:45');
    assert.equal(onlySub().notify_time, '06:45:00');
  });

  it('rejects a malformed time before touching the database', async () => {
    state.subs.push(sub());
    await assert.rejects(() => setNotifyTime(db, 'u1', '25:00'), InvalidNotifyTimeError);
    assert.equal(onlySub().notify_time, '20:00:00');
  });

  it('returns null (nothing updated) when the user has no subscription', async () => {
    assert.equal(await setNotifyTime(db, 'u1', '06:45'), null);
  });
});

describe('logSent / logSkipped', () => {
  const now = new Date('2026-08-01T13:00:00Z');

  it('writes a sent row', async () => {
    assert.deepEqual(await logSent(db, 'u1', '2026-08-01', now), { deduped: false });
    assert.equal(onlyLog().skipped, false);
    assert.equal(onlyLog().skip_reason, null);
  });

  it('writes a skip row with its reason', async () => {
    await logSkipped(db, 'u1', '2026-08-01', 'already_wrote', now);
    assert.equal(onlyLog().skipped, true);
    assert.equal(onlyLog().skip_reason, 'already_wrote');
  });

  it('reports a same-day duplicate as deduped instead of throwing', async () => {
    // This IS the sweep's once-per-Bangkok-day guard; a retry must land here.
    await logSent(db, 'u1', '2026-08-01', now);
    assert.deepEqual(await logSent(db, 'u1', '2026-08-01', now), { deduped: true });
    assert.equal(state.logs.length, 1);
  });

  it('treats a skip as claiming the day too', async () => {
    await logSkipped(db, 'u1', '2026-08-01', 'already_wrote', now);
    assert.deepEqual(await logSent(db, 'u1', '2026-08-01', now), { deduped: true });
  });

  it('allows the next day, and another user on the same day', async () => {
    await logSent(db, 'u1', '2026-08-01', now);
    assert.deepEqual(await logSent(db, 'u1', '2026-08-02', now), { deduped: false });
    assert.deepEqual(await logSent(db, 'u2', '2026-08-01', now), { deduped: false });
    assert.equal(state.logs.length, 3);
  });
});

describe('alreadyWrittenToday', () => {
  it('is false when there is no entry', async () => {
    assert.equal(await alreadyWrittenToday(db, 'u1', '2026-08-01'), false);
  });

  it('is true for a live entry on that Bangkok day', async () => {
    state.entries.push({ id: 'e1', user_id: 'u1', entry_date: '2026-08-01', deleted_at: null });
    assert.equal(await alreadyWrittenToday(db, 'u1', '2026-08-01'), true);
  });

  it('ignores a soft-deleted entry', async () => {
    // Deleting today's entry means, for reminder purposes, today is unwritten.
    state.entries.push({
      id: 'e1',
      user_id: 'u1',
      entry_date: '2026-08-01',
      deleted_at: '2026-08-01T12:00:00Z',
    });
    assert.equal(await alreadyWrittenToday(db, 'u1', '2026-08-01'), false);
  });

  it('ignores another day and another user', async () => {
    state.entries.push({ id: 'e1', user_id: 'u1', entry_date: '2026-07-31', deleted_at: null });
    state.entries.push({ id: 'e2', user_id: 'u2', entry_date: '2026-08-01', deleted_at: null });
    assert.equal(await alreadyWrittenToday(db, 'u1', '2026-08-01'), false);
  });
});

describe('listDueSubscribers', () => {
  const now = new Date('2026-08-15T00:00:00Z');

  it('selects only times inside the requested Bangkok hour', async () => {
    state.subs.push(sub({ id: 's1', user_id: 'u1', notify_time: '20:00:00' }));
    state.subs.push(sub({ id: 's2', user_id: 'u2', notify_time: '20:59:00' }));
    state.subs.push(sub({ id: 's3', user_id: 'u3', notify_time: '21:00:00' }));
    state.subs.push(sub({ id: 's4', user_id: 'u4', notify_time: '19:59:00' }));
    const due = await listDueSubscribers(db, 20, now);
    assert.deepEqual(
      due.map((d) => d.user_id).sort(),
      ['u1', 'u2'],
    );
  });

  it('pads a single-digit hour so 07:00 is not read as 7:00', async () => {
    state.subs.push(sub({ user_id: 'u1', notify_time: '07:30:00' }));
    const due = await listDueSubscribers(db, 7, now);
    assert.equal(due.length, 1);
  });

  it('excludes cancelled and expired subscriptions', async () => {
    state.subs.push(sub({ id: 's1', user_id: 'u1', status: 'cancelled' }));
    state.subs.push(sub({ id: 's2', user_id: 'u2', expires_at: '2026-08-01T00:00:00Z' }));
    state.subs.push(sub({ id: 's3', user_id: 'u3' }));
    const due = await listDueSubscribers(db, 20, now);
    assert.deepEqual(due.map((d) => d.user_id), ['u3']);
  });
});
