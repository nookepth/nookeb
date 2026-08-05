import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * FIX 4 — the watchdog, and the heartbeat it reads.
 *
 * THE PROPERTY: a sweep that stops running produces an alert. Before this, the
 * sweep's only evidence of having run was a console.log at the end of a run —
 * which is, by construction, not printed when the run does not happen. Nobody
 * can grep for absence, so the absence had to become a positive fact
 * (job_heartbeats) with something outside the worker watching it go stale.
 *
 * Also pinned here: "it ran and threw every time" alerts the same as "it stopped
 * running". They are equally useless outcomes, and a watchdog that only checked
 * `last_run_at` would call a permanently-crashing sweep healthy.
 *
 * Config is supplied locally — ops-alert.service reads it at import, and a
 * skip-guard would mean the regression test for a silent cleanup outage never
 * runs on a developer machine. ADMIN_LINE_USER_ID is left UNSET so the alert
 * path exercises the "no paging channel configured" branch without touching the
 * network; the row is what these tests assert on.
 */

process.env.VAULT_MASTER_KEY ??= '0'.repeat(63) + '1';
delete process.env.ADMIN_LINE_USER_ID;

type WatchdogModule = typeof import('./sweep-watchdog');
type HeartbeatModule = typeof import('./job-heartbeat.service');

let watchdog: WatchdogModule;
let heartbeat: HeartbeatModule;

interface AlertRow {
  id: string;
  key: string;
  severity: string;
  title: string;
  detail: unknown;
  occurrences: number;
  last_notified_at: string | null;
  first_seen_at: string;
  resolved_at: string | null;
}

interface Rec {
  alerts: AlertRow[];
  heartbeatUpserts: Record<string, unknown>[];
}

const JOB = 'sheets_trial_expiry';

function fakeSupabase(
  heartbeats: Record<string, unknown>[],
  rec: Rec,
  opts: { heartbeatTableMissing?: boolean } = {},
): SupabaseClient {
  const from = (table: string): Record<string, unknown> => {
    if (table === 'job_heartbeats') {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () =>
          opts.heartbeatTableMissing
            ? { data: null, error: { code: '42P01', message: 'relation does not exist' } }
            : { data: heartbeats[0] ?? null, error: null },
        upsert: async (values: Record<string, unknown>) => {
          rec.heartbeatUpserts.push(values);
          return { error: null };
        },
      };
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve(
          opts.heartbeatTableMissing
            ? { data: null, error: { code: '42P01', message: 'relation does not exist' } }
            : { data: heartbeats, error: null },
        );
      return b;
    }

    if (table === 'ops_alerts') {
      // Filters are APPLIED, and by whichever column was named: raiseOpsAlert
      // updates by `id` while resolveOpsAlert updates by `key` + open-ness, and
      // a fake that matched only one of those would report the dedupe as
      // working when it was not.
      let key = '';
      let id = '';
      let mode: 'select' | 'update' | 'insert' = 'select';
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
        is: (_c: string, _v: unknown) => {
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
          mode = 'insert';
          rec.alerts.push({
            id: `alert-${rec.alerts.length + 1}`,
            key: String(v.key),
            severity: String(v.severity),
            title: String(v.title),
            detail: v.detail,
            occurrences: 1,
            last_notified_at: null,
            first_seen_at: String(v.first_seen_at),
            resolved_at: null,
          });
          return { error: null };
        },
      };
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: rec.alerts.filter((a) => !a.resolved_at), error: null });
      return b;
    }

    throw new Error(`unexpected table ${table}`);
  };
  return { from } as unknown as SupabaseClient;
}

function blank(): Rec {
  return { alerts: [], heartbeatUpserts: [] };
}

const NOW = new Date('2026-08-05T12:00:00.000Z');
const minutesAgo = (n: number): string => new Date(NOW.getTime() - n * 60_000).toISOString();

function hb(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_name: JOB,
    last_success_at: minutesAgo(5),
    last_run_at: minutesAgo(5),
    consecutive_failures: 0,
    consecutive_full_batches: 0,
    last_result: null,
    ...overrides,
  };
}

describe('runSweepWatchdog', () => {
  beforeEach(async () => {
    watchdog = await import('./sweep-watchdog');
    heartbeat = await import('./job-heartbeat.service');
  });

  it('stays quiet while the sweep is succeeding on schedule', async () => {
    const rec = blank();
    const findings = await watchdog.runSweepWatchdog(fakeSupabase([hb()], rec), NOW);

    assert.equal(findings[0]!.stalled, false);
    assert.deepEqual(rec.alerts, [], 'a healthy sweep must never page anyone');
  });

  it('raises a CRITICAL alert once no run has succeeded for an hour', async () => {
    const rec = blank();
    const findings = await watchdog.runSweepWatchdog(
      fakeSupabase([hb({ last_success_at: minutesAgo(75) })], rec),
      NOW,
    );

    assert.equal(findings[0]!.stalled, true);
    assert.equal(rec.alerts.length, 1);
    assert.equal(rec.alerts[0]!.key, watchdog.sweepStalledKey(JOB));
    assert.equal(rec.alerts[0]!.severity, 'critical');
    // The alert has to say what it COSTS, or the reader has to work it out at
    // 3am from a job name.
    assert.match(
      JSON.stringify(rec.alerts[0]!.detail),
      /credentials/,
      'the alert must name the consequence, not just the late job',
    );
  });

  it('treats a sweep that RUNS but always throws as stalled', async () => {
    // last_run_at is fresh; last_success_at is not. A watchdog on last_run_at
    // would call this healthy — it is not: nothing has been revoked in an hour
    // either way.
    const rec = blank();
    const findings = await watchdog.runSweepWatchdog(
      fakeSupabase(
        [hb({ last_run_at: minutesAgo(1), last_success_at: minutesAgo(90), consecutive_failures: 6 })],
        rec,
      ),
      NOW,
    );

    assert.equal(findings[0]!.stalled, true);
    assert.equal(findings[0]!.consecutiveFailures, 6);
    assert.equal(rec.alerts.length, 1);
  });

  it('does not open a second alert while the first is still open', async () => {
    // 96 identical LINE messages is not an alert, it is noise that trains
    // people to ignore the channel — and it burns metered push quota.
    const rec = blank();
    const supabase = fakeSupabase([hb({ last_success_at: minutesAgo(75) })], rec);

    await watchdog.runSweepWatchdog(supabase, NOW);
    await watchdog.runSweepWatchdog(supabase, NOW);
    await watchdog.runSweepWatchdog(supabase, NOW);

    assert.equal(rec.alerts.length, 1, 'one condition, one open row');
    assert.equal(rec.alerts[0]!.occurrences, 3, 'but the recurrence is still counted');
  });

  it('closes its own alert when the sweep recovers', async () => {
    // Otherwise the open list means "was broken once", which is the state in
    // which people stop reading it.
    const rec = blank();
    await watchdog.runSweepWatchdog(
      fakeSupabase([hb({ last_success_at: minutesAgo(75) })], rec),
      NOW,
    );
    assert.equal(rec.alerts.filter((a) => !a.resolved_at).length, 1);

    await watchdog.runSweepWatchdog(fakeSupabase([hb()], rec), NOW);
    assert.equal(
      rec.alerts.filter((a) => !a.resolved_at).length,
      0,
      'a recovered sweep must close its own alert',
    );
  });

  it('does not page about a job that has simply never run yet', async () => {
    // A fresh deployment (or one that has just applied migration 065) has no
    // heartbeat row. Paging on every boot is exactly the false positive that
    // gets an alert channel muted.
    const rec = blank();
    const findings = await watchdog.runSweepWatchdog(fakeSupabase([], rec), NOW);

    assert.equal(findings[0]!.staleForMs, null);
    assert.equal(findings[0]!.stalled, false);
    assert.deepEqual(rec.alerts, []);
  });

  it('degrades to no findings rather than throwing when 065 is unapplied', async () => {
    const rec = blank();
    const findings = await watchdog.runSweepWatchdog(
      fakeSupabase([], rec, { heartbeatTableMissing: true }),
      NOW,
    );
    // No heartbeat rows readable → nothing looks stale → nothing is paged.
    // Observability must never be able to break, or alert about, itself.
    assert.equal(findings[0]!.stalled, false);
    assert.deepEqual(rec.alerts, []);
  });
});

describe('recordJobHeartbeat', () => {
  beforeEach(async () => {
    heartbeat = await import('./job-heartbeat.service');
  });

  it('advances last_success_at only on a successful run', async () => {
    const rec = blank();
    await heartbeat.recordJobHeartbeat(fakeSupabase([hb()], rec), {
      jobName: JOB,
      ok: true,
      now: NOW,
    });
    assert.equal(rec.heartbeatUpserts[0]!.last_success_at, NOW.toISOString());
    assert.equal(rec.heartbeatUpserts[0]!.consecutive_failures, 0);
  });

  it('leaves last_success_at untouched on a failed run, and counts the streak', async () => {
    const rec = blank();
    await heartbeat.recordJobHeartbeat(
      fakeSupabase([hb({ consecutive_failures: 2 })], rec),
      { jobName: JOB, ok: false, now: NOW },
    );
    const written = rec.heartbeatUpserts[0]!;
    assert.equal(
      'last_success_at' in written,
      false,
      'a failed run must not claim the job succeeded',
    );
    assert.equal(written.last_run_at, NOW.toISOString());
    assert.equal(written.consecutive_failures, 3);
  });

  it('never throws when migration 065 is unapplied', async () => {
    const rec = blank();
    const res = await heartbeat.recordJobHeartbeat(
      fakeSupabase([], rec, { heartbeatTableMissing: true }),
      { jobName: JOB, ok: true, now: NOW },
    );
    // A throw here would fail the BullMQ job, and the retry would re-run a
    // sweep that has already revoked credentials and sent pushes.
    assert.deepEqual(res, { consecutiveFailures: null, consecutiveFullBatches: null });
  });
});
