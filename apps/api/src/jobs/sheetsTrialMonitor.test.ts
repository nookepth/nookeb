import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * FIX 5 — the per-run batch cap stops being silent.
 *
 * The sweep handles at most 200 users per 15-minute run (~19.2k/day). That
 * ceiling is correct and should stay: an uncapped run would hold the
 * concurrency-1 membership worker for an unbounded stretch and starve the
 * quota/boost/diary sweeps queued behind it. The problem was that REACHING the
 * ceiling produced no signal at all — a backlog would just take longer and
 * longer to drain, with expired trials keeping their Google credentials the
 * whole time, and nothing said so.
 *
 * THE PROPERTY: a STREAK of full batches alerts; a single full batch does not.
 * One full run is what a healthy sweep looks like the first time work arrives
 * in a lump (a marketing push fourteen days ago lands every one of those trials
 * in the same hour), and paging on it would train people to ignore the channel.
 * Three in a row is the queue never emptying, which is the only condition under
 * which the cap actually delays a revocation indefinitely.
 */

process.env.VAULT_MASTER_KEY ??= '0'.repeat(63) + '1';
delete process.env.ADMIN_LINE_USER_ID;

type MonitorModule = typeof import('./sheetsTrialMonitor');
type SweepResult = import('./sheetsTrialExpiry.job').SheetsTrialExpiryResult;

let monitor: MonitorModule;

interface AlertRow {
  id: string;
  key: string;
  occurrences: number;
  resolved_at: string | null;
  detail: unknown;
  title: string;
}

interface Rec {
  alerts: AlertRow[];
  /** The heartbeat row, mutated in place so a streak accumulates across runs. */
  heartbeat: { consecutive_failures: number; consecutive_full_batches: number };
}

function blank(): Rec {
  return { alerts: [], heartbeat: { consecutive_failures: 0, consecutive_full_batches: 0 } };
}

function fakeSupabase(rec: Rec): SupabaseClient {
  const from = (table: string): Record<string, unknown> => {
    if (table === 'job_heartbeats') {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: { ...rec.heartbeat }, error: null }),
        upsert: async (values: Record<string, unknown>) => {
          rec.heartbeat.consecutive_failures = Number(values.consecutive_failures);
          rec.heartbeat.consecutive_full_batches = Number(values.consecutive_full_batches);
          return { error: null };
        },
      };
      return b;
    }

    if (table === 'ops_alerts') {
      let key = '';
      let id = '';
      let mode: 'select' | 'update' = 'select';
      let values: Record<string, unknown> = {};
      const target = (): AlertRow | undefined =>
        id
          ? rec.alerts.find((a) => a.id === id)
          : rec.alerts.find((a) => a.key === key && !a.resolved_at);
      const b: Record<string, unknown> = {
        select: () => b,
        order: () => b,
        limit: () => b,
        eq: (col: string, v: string) => {
          if (col === 'id') id = v;
          else key = v;
          if (mode === 'update') {
            const open = target();
            if (open) Object.assign(open, values);
            return Promise.resolve({ error: null });
          }
          return b;
        },
        is: () => {
          if (mode === 'update') {
            const open = target();
            if (open) Object.assign(open, values);
            return Promise.resolve({ error: null });
          }
          return b;
        },
        maybeSingle: async () => ({ data: target() ?? null, error: null }),
        update: (v: Record<string, unknown>) => {
          mode = 'update';
          values = v;
          return b;
        },
        insert: async (v: Record<string, unknown>) => {
          rec.alerts.push({
            id: `alert-${rec.alerts.length + 1}`,
            key: String(v.key),
            title: String(v.title),
            detail: v.detail,
            occurrences: 1,
            resolved_at: null,
          });
          return { error: null };
        },
      };
      return b;
    }

    throw new Error(`unexpected table ${table}`);
  };
  return { from } as unknown as SupabaseClient;
}

function sweep(overrides: Partial<SweepResult> = {}): SweepResult {
  return {
    examined: 5,
    revoked: 5,
    keptOnPlan: 0,
    nothingToRevoke: 0,
    deferred: 0,
    orphaned: 0,
    skipped: false,
    batchSize: 200,
    atCap: false,
    ...overrides,
  };
}

const full = (): SweepResult => sweep({ examined: 200, revoked: 200, atCap: true });

const openAlerts = (rec: Rec) => rec.alerts.filter((a) => !a.resolved_at);

describe('recordSweepOutcome — backlog signal', () => {
  beforeEach(async () => {
    monitor = await import('./sheetsTrialMonitor');
  });

  it('says nothing about a run that came back under the cap', async () => {
    const rec = blank();
    await monitor.recordSweepOutcome(fakeSupabase(rec), sweep());
    assert.deepEqual(openAlerts(rec), []);
    assert.equal(rec.heartbeat.consecutive_full_batches, 0);
  });

  it('does NOT alert on a single full batch', async () => {
    // One full run is a burst, not a backlog. Paging on it is how a channel
    // gets muted.
    const rec = blank();
    await monitor.recordSweepOutcome(fakeSupabase(rec), full());
    assert.equal(rec.heartbeat.consecutive_full_batches, 1);
    assert.deepEqual(openAlerts(rec), []);
  });

  it('does not alert on two in a row either', async () => {
    const rec = blank();
    const supabase = fakeSupabase(rec);
    await monitor.recordSweepOutcome(supabase, full());
    await monitor.recordSweepOutcome(supabase, full());
    assert.equal(rec.heartbeat.consecutive_full_batches, 2);
    assert.deepEqual(openAlerts(rec), []);
  });

  it('alerts once the streak reaches the threshold', async () => {
    const rec = blank();
    const supabase = fakeSupabase(rec);
    for (let i = 0; i < monitor.BACKLOG_ALERT_AFTER_RUNS; i += 1) {
      await monitor.recordSweepOutcome(supabase, full());
    }

    const open = openAlerts(rec);
    assert.equal(open.length, 1);
    assert.equal(open[0]!.key, monitor.BACKLOG_ALERT_KEY);
    // The alert must carry the two things an on-call engineer can act on
    // immediately — neither is obvious from a queue-depth number.
    const detail = JSON.stringify(open[0]!.detail);
    assert.match(detail, /batchSize/);
    assert.match(detail, /SHEETS_TRIAL_EXPIRY_CRON/);
  });

  it('breaks the streak the moment one run comes back under the cap', async () => {
    const rec = blank();
    const supabase = fakeSupabase(rec);
    await monitor.recordSweepOutcome(supabase, full());
    await monitor.recordSweepOutcome(supabase, full());
    await monitor.recordSweepOutcome(supabase, sweep({ examined: 12 }));

    assert.equal(rec.heartbeat.consecutive_full_batches, 0);
    assert.deepEqual(openAlerts(rec), []);
  });

  it('closes an open backlog alert once the queue drains', async () => {
    const rec = blank();
    const supabase = fakeSupabase(rec);
    for (let i = 0; i < monitor.BACKLOG_ALERT_AFTER_RUNS; i += 1) {
      await monitor.recordSweepOutcome(supabase, full());
    }
    assert.equal(openAlerts(rec).length, 1);

    await monitor.recordSweepOutcome(supabase, sweep({ examined: 3 }));
    assert.deepEqual(openAlerts(rec), [], 'the open list must mean "still true"');
  });

  it('leaves the streak alone on a SKIPPED run', async () => {
    // A pre-062 database reads nothing. That is not a full batch, and it is not
    // evidence of an empty queue either — resetting the streak on it would
    // discard a real backlog signal on no information.
    const rec = blank();
    const supabase = fakeSupabase(rec);
    await monitor.recordSweepOutcome(supabase, full());
    await monitor.recordSweepOutcome(supabase, full());
    await monitor.recordSweepOutcome(supabase, sweep({ examined: 0, skipped: true }));

    assert.equal(rec.heartbeat.consecutive_full_batches, 2);
  });

  it('never throws when the heartbeat table is missing', async () => {
    const broken = {
      from: () => {
        throw new Error('relation "job_heartbeats" does not exist');
      },
    } as unknown as SupabaseClient;

    // A throw here would fail the BullMQ job, and the retry would re-run a
    // sweep that has already revoked credentials and sent pushes.
    await monitor.recordSweepOutcome(broken, full());
  });
});
