import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  runDiaryAddonSweep,
  buildDiaryAddonReminderCard,
  hourInTimezone,
  isDueThisHour,
} from './diaryReminder.job';
import type { DiaryAddonSubscriptionRecord } from '../services/diaryAddon.service';

/**
 * The หนูเก็บความทรงจำ hourly sweep.
 *
 * This is the one part of the add-on that leaves the database and spends a
 * metered LINE push, so the properties under test are the ones that would
 * either annoy a paying user or waste quota:
 *
 *   - the master switch stands the sweep down before any DB or push work;
 *   - a user who already wrote today is SKIPPED and the skip is recorded;
 *   - a lapsed subscription is caught by the per-user re-check even when the
 *     batch query let it through (it can lapse between query and push);
 *   - the day is claimed BEFORE pushing, so a retry cannot double-message;
 *   - one failed push does not stop the rest of the hour's subscribers.
 *
 * The Supabase fake here is deliberately narrower than the service test's: this
 * suite is about CONTROL FLOW, so it stubs the four reads/writes the sweep makes
 * and asserts on the calls, rather than re-simulating PostgREST.
 */

interface Scenario {
  due: DiaryAddonSubscriptionRecord[];
  lineIds: Record<string, string | null>;
  wroteToday: Set<string>;
  /** user ids whose per-user re-check should report a live subscription */
  live: Set<string>;
  /**
   * user ids with diary_notification_settings.notification_enabled = TRUE
   * (migration 053). Defaults to "every due subscriber", since buying the
   * add-on sets the flag — the opt-out cases pass a narrower set explicitly.
   */
  optedIn: Set<string>;
}

interface Recorded {
  pushes: { to: string }[];
  logs: { userId: string; date: string; skipped: boolean; reason: string | null }[];
  /** user ids already logged for the day — makes the insert report a duplicate */
  claimed: Set<string>;
}

function sub(userId: string, notifyTime = '20:00:00'): DiaryAddonSubscriptionRecord {
  return {
    id: `sub-${userId}`,
    user_id: userId,
    status: 'active',
    billing_cycle: 'monthly',
    price_thb: 49,
    started_at: '2026-08-01T00:00:00.000Z',
    expires_at: '2026-09-01T00:00:00.000Z',
    cancelled_at: null,
    notify_time: notifyTime,
    created_at: '2026-08-01T00:00:00.000Z',
  };
}

function fakeSupabase(scenario: Scenario, rec: Recorded): SupabaseClient {
  return {
    from(table: string) {
      if (table === 'diary_addon_subscriptions') {
        return {
          select: () => {
            // Two shapes reach this table: listDueSubscribers (a filter chain
            // ending in .limit) and getSubscription (ending in .maybeSingle).
            let userId: string | null = null;
            const api: Record<string, unknown> = {
              eq(column: string, value: unknown) {
                if (column === 'user_id') userId = value as string;
                return api;
              },
              gt: () => api,
              gte: () => api,
              lte: () => api,
              limit: () => Promise.resolve({ data: scenario.due, error: null }),
              maybeSingle: () =>
                Promise.resolve({
                  data:
                    userId && scenario.live.has(userId)
                      ? sub(userId)
                      : userId
                        ? { ...sub(userId), status: 'expired' }
                        : null,
                  error: null,
                }),
            };
            return api;
          },
        };
      }

      if (table === 'users') {
        return {
          select: () => ({
            in: (_col: string, ids: string[]) =>
              Promise.resolve({
                data: ids.map((id) => ({ id, line_user_id: scenario.lineIds[id] ?? null })),
                error: null,
              }),
          }),
        };
      }

      if (table === 'diary_entries') {
        return {
          select: () => {
            let userId = '';
            const api: Record<string, unknown> = {
              eq(column: string, value: unknown) {
                if (column === 'user_id') userId = value as string;
                return api;
              },
              is: () => api,
              limit: () =>
                Promise.resolve({
                  data: scenario.wroteToday.has(userId) ? [{ id: 'entry' }] : [],
                  error: null,
                }),
            };
            return api;
          },
        };
      }

      if (table === 'diary_notification_settings') {
        // listPushOptedInUserIds: .select('user_id').in(...).eq('notification_enabled', true)
        return {
          select: () => {
            let ids: string[] = [];
            const api: Record<string, unknown> = {
              in(_col: string, values: string[]) {
                ids = values;
                return api;
              },
              eq: () =>
                Promise.resolve({
                  data: ids.filter((id) => scenario.optedIn.has(id)).map((id) => ({ user_id: id })),
                  error: null,
                }),
            };
            return api;
          },
        };
      }

      if (table === 'diary_addon_logs') {
        return {
          insert: (values: Record<string, unknown>) => {
            const userId = values.user_id as string;
            if (rec.claimed.has(userId)) {
              return Promise.resolve({ data: null, error: { code: '23505' } });
            }
            rec.claimed.add(userId);
            rec.logs.push({
              userId,
              date: values.date as string,
              skipped: values.skipped as boolean,
              reason: (values.skip_reason as string | null) ?? null,
            });
            return Promise.resolve({ data: null, error: null });
          },
        };
      }

      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
}

/** 20:30 ICT — the hour every scenario below is written against. */
const NOW = new Date('2026-08-01T13:30:00Z');

let rec: Recorded;

beforeEach(() => {
  rec = { pushes: [], logs: [], claimed: new Set() };
});

function run(scenario: Partial<Scenario>, over: { enabled?: boolean; failFor?: string } = {}) {
  const full: Scenario = {
    due: scenario.due ?? [],
    lineIds: scenario.lineIds ?? {},
    wroteToday: scenario.wroteToday ?? new Set(),
    live: scenario.live ?? new Set((scenario.due ?? []).map((s) => s.user_id)),
    optedIn: scenario.optedIn ?? new Set((scenario.due ?? []).map((s) => s.user_id)),
  };
  return runDiaryAddonSweep(fakeSupabase(full, rec), {
    enabled: over.enabled ?? true,
    now: NOW,
    webUrl: 'https://example.test',
    push: async (to) => {
      if (over.failFor && to === over.failFor) throw new Error('LINE push failed: 429');
      rec.pushes.push({ to });
    },
  });
}

// ---------------------------------------------------------------------------

describe('runDiaryAddonSweep — master switch', () => {
  it('stands down and touches nothing when DIARY_ADDON_ENABLED is false', async () => {
    // The supabase client is a booby trap: any table access throws.
    const trap = {
      from() {
        throw new Error('the disabled sweep must not touch the database');
      },
    } as unknown as SupabaseClient;

    const result = await runDiaryAddonSweep(trap, {
      enabled: false,
      now: NOW,
      push: async () => {
        throw new Error('the disabled sweep must not push');
      },
    });

    assert.deepEqual(result, {
      candidates: 0,
      sent: 0,
      skippedWroteToday: 0,
      skippedExpired: 0,
      skippedAlreadyLogged: 0,
      skippedNotOptedIn: 0,
      failed: 0,
    });
  });
});

describe('runDiaryAddonSweep — per-user decisions', () => {
  it('pushes once to a live subscriber due this hour', async () => {
    const result = await run({
      due: [sub('u1')],
      lineIds: { u1: 'Uline1' },
    });

    assert.equal(result.candidates, 1);
    assert.equal(result.sent, 1);
    assert.deepEqual(rec.pushes, [{ to: 'Uline1' }]);
    assert.deepEqual(rec.logs, [
      { userId: 'u1', date: '2026-08-01', skipped: false, reason: null },
    ]);
  });

  it("skips a user who already wrote today, with reason 'already_wrote'", async () => {
    const result = await run({
      due: [sub('u1')],
      lineIds: { u1: 'Uline1' },
      wroteToday: new Set(['u1']),
    });

    assert.equal(result.sent, 0);
    assert.equal(result.skippedWroteToday, 1);
    assert.deepEqual(rec.pushes, []);
    assert.deepEqual(rec.logs, [
      { userId: 'u1', date: '2026-08-01', skipped: true, reason: 'already_wrote' },
    ]);
  });

  it("skips a lapsed subscription caught by the re-check, with reason 'expired'", async () => {
    // The batch query returned this row, but the per-user re-check finds it is
    // no longer live — a subscription can lapse between the two.
    const result = await run({
      due: [sub('u1')],
      lineIds: { u1: 'Uline1' },
      live: new Set(),
    });

    assert.equal(result.sent, 0);
    assert.equal(result.skippedExpired, 1);
    assert.deepEqual(rec.pushes, []);
    assert.deepEqual(rec.logs, [
      { userId: 'u1', date: '2026-08-01', skipped: true, reason: 'expired' },
    ]);
  });

  it('checks "already wrote" BEFORE the subscription re-check', async () => {
    // Both conditions true: the user-facing reason must be the one that
    // explains the silence honestly, not the billing one.
    const result = await run({
      due: [sub('u1')],
      lineIds: { u1: 'Uline1' },
      wroteToday: new Set(['u1']),
      live: new Set(),
    });
    assert.equal(result.skippedWroteToday, 1);
    assert.equal(result.skippedExpired, 0);
  });

  it('does not push twice when the day was already claimed (job retry)', async () => {
    rec.claimed.add('u1');
    const result = await run({ due: [sub('u1')], lineIds: { u1: 'Uline1' } });

    assert.equal(result.sent, 0);
    assert.equal(result.skippedAlreadyLogged, 1);
    assert.deepEqual(rec.pushes, []);
  });

  it('counts a user with no LINE id as failed rather than pushing to nothing', async () => {
    const result = await run({ due: [sub('u1')], lineIds: { u1: null } });
    assert.equal(result.failed, 1);
    assert.equal(result.sent, 0);
    assert.deepEqual(rec.pushes, []);
  });
});

describe('runDiaryAddonSweep — isolation between users', () => {
  it('keeps processing after one push fails', async () => {
    const result = await run(
      {
        due: [sub('u1'), sub('u2'), sub('u3')],
        lineIds: { u1: 'Uline1', u2: 'Uline2', u3: 'Uline3' },
      },
      { failFor: 'Uline2' },
    );

    assert.equal(result.sent, 2);
    assert.equal(result.failed, 1);
    assert.deepEqual(
      rec.pushes.map((p) => p.to),
      ['Uline1', 'Uline3'],
    );
  });

  it('mixes sends and skips in one run without cross-contamination', async () => {
    const result = await run({
      due: [sub('u1'), sub('u2'), sub('u3')],
      lineIds: { u1: 'Uline1', u2: 'Uline2', u3: 'Uline3' },
      wroteToday: new Set(['u2']),
      live: new Set(['u1', 'u2']), // u3 lapsed
    });

    assert.equal(result.candidates, 3);
    assert.equal(result.sent, 1);
    assert.equal(result.skippedWroteToday, 1);
    assert.equal(result.skippedExpired, 1);
    assert.deepEqual(
      rec.pushes.map((p) => p.to),
      ['Uline1'],
    );
  });

  it('returns early with no push when nobody is due this hour', async () => {
    const result = await run({ due: [] });
    assert.equal(result.candidates, 0);
    assert.deepEqual(rec.pushes, []);
  });
});

describe('runDiaryAddonSweep — push opt-in (migration 053)', () => {
  it('sends nothing to a subscriber who switched the toggle off', async () => {
    const result = await run({
      due: [sub('u1')],
      lineIds: { u1: 'U1' },
      optedIn: new Set(),
    });

    assert.equal(result.candidates, 1);
    assert.equal(result.sent, 0);
    assert.equal(result.skippedNotOptedIn, 1);
    assert.deepEqual(rec.pushes, []);
  });

  it('does not burn the day on an opt-out, so turning it back on still works', async () => {
    // diary_addon_logs' UNIQUE(user_id, date) is the day's idempotency key: a
    // log row written for "not opted in" would block the nudge for the rest of
    // the day even after the user re-enabled it.
    await run({ due: [sub('u1')], lineIds: { u1: 'U1' }, optedIn: new Set() });
    assert.deepEqual(rec.logs, []);
  });

  it('nudges the opted-in subscriber and skips the opted-out one in the same run', async () => {
    const result = await run({
      due: [sub('u1'), sub('u2')],
      lineIds: { u1: 'U1', u2: 'U2' },
      optedIn: new Set(['u2']),
    });

    assert.equal(result.sent, 1);
    assert.equal(result.skippedNotOptedIn, 1);
    assert.deepEqual(
      rec.pushes.map((p) => p.to),
      ['U2'],
    );
  });
});

describe('buildDiaryAddonReminderCard', () => {
  it('carries the Thai copy and a diary deep link', () => {
    const card = buildDiaryAddonReminderCard('https://example.test');
    const json = JSON.stringify(card);
    assert.match(card.altText, /หนูเก็บ ทักมาเตือนน้า/);
    assert.ok(json.includes('อย่าลืมบันทึกความทรงจำของวันนี้ไว้นะ'));
    assert.ok(json.includes('https://example.test/dashboard/diary'));
    assert.ok(json.includes('เขียนเลย'));
  });

  it('omits the button entirely rather than emitting a broken link', () => {
    const card = buildDiaryAddonReminderCard(undefined);
    assert.equal((card.contents as Record<string, unknown>).footer, undefined);
  });

  it('contains no emoji (brand rule 13)', () => {
    const json = JSON.stringify(buildDiaryAddonReminderCard('https://example.test'));
    assert.equal(/\p{Extended_Pictographic}/u.test(json), false);
  });
});

/**
 * §17 hour matching — the whole reason the sweep went from daily to hourly.
 *
 * Pure and therefore cheap to pin down, which matters: this is the decision
 * that determines whether a user is messaged at the time they picked or at the
 * time the cron happened to fire. Two properties are load-bearing:
 *
 *   - notify_time is matched to the HOUR (an hourly sweep cannot do better);
 *   - the per-user `timezone` column, stored since migration 028 and never
 *     honoured server-side until now, actually shifts the match.
 */
describe('§17 diary reminder — hour matching', () => {
  // 2026-08-01 13:00 UTC = 20:00 Bangkok = 15:00 UTC+2 = 06:00 America/Los_Angeles
  const at = new Date('2026-08-01T13:00:00Z');

  it('reads the current hour in the user’s own timezone', () => {
    assert.equal(hourInTimezone(at, 'Asia/Bangkok'), 20);
    assert.equal(hourInTimezone(at, 'UTC'), 13);
    assert.equal(hourInTimezone(at, 'America/Los_Angeles'), 6);
  });

  it('falls back to Bangkok for a missing or unparseable timezone', () => {
    assert.equal(hourInTimezone(at, null), 20);
    assert.equal(hourInTimezone(at, ''), 20);
    assert.equal(hourInTimezone(at, 'Not/AZone'), 20);
  });

  it('matches notify_time to the hour, ignoring minutes', () => {
    assert.equal(isDueThisHour('20:00:00', at, 'Asia/Bangkok'), true);
    assert.equal(isDueThisHour('20:45:00', at, 'Asia/Bangkok'), true);
    assert.equal(isDueThisHour('21:00:00', at, 'Asia/Bangkok'), false);
    assert.equal(isDueThisHour('19:59:00', at, 'Asia/Bangkok'), false);
  });

  it('honours the timezone: 20:00 means 20:00 WHERE THE USER IS', () => {
    // Same instant, same stored notify_time, different timezone → not due.
    assert.equal(isDueThisHour('20:00:00', at, 'Asia/Bangkok'), true);
    assert.equal(isDueThisHour('20:00:00', at, 'UTC'), false);
    // ...and the UTC user is due at their own 20:00 instead.
    assert.equal(isDueThisHour('20:00:00', new Date('2026-08-01T20:00:00Z'), 'UTC'), true);
  });

  it('treats a missing or malformed notify_time as never due', () => {
    // Never due beats always due: a bad row must not push every hour.
    assert.equal(isDueThisHour(null, at, 'Asia/Bangkok'), false);
    assert.equal(isDueThisHour(undefined, at, 'Asia/Bangkok'), false);
    assert.equal(isDueThisHour('', at, 'Asia/Bangkok'), false);
    assert.equal(isDueThisHour('99:00:00', at, 'Asia/Bangkok'), false);
    assert.equal(isDueThisHour('ab:cd:ef', at, 'Asia/Bangkok'), false);
  });

  it('covers midnight, where an hour12 formatter would report 24', () => {
    const midnightBkk = new Date('2026-08-01T17:00:00Z'); // 00:00 next day in ICT
    assert.equal(hourInTimezone(midnightBkk, 'Asia/Bangkok'), 0);
    assert.equal(isDueThisHour('00:00:00', midnightBkk, 'Asia/Bangkok'), true);
  });
});
