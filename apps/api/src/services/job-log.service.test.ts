import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { writeJobLog } from './job-log.service';

/**
 * job_log (migration 060). Same one property as push_log, for a sharper reason.
 *
 * writeJobLog is called from BullMQ 'completed'/'failed' EVENT LISTENERS in
 * workers/index.ts. A rejected promise inside one of those is an
 * unhandledRejection, and that process installs a handler that calls
 * process.exit(1) on unhandledRejection. An unavailable job_log table would
 * therefore RESTART-LOOP THE WORKER — the observability layer taking down the
 * thing it observes.
 */

function erroringDb(): SupabaseClient {
  return {
    from: () => ({
      insert: async () => ({ data: null, error: { message: 'relation "job_log" does not exist' } }),
    }),
  } as unknown as SupabaseClient;
}

function throwingDb(): SupabaseClient {
  return {
    from: () => ({ insert: () => Promise.reject(new Error('ECONNRESET')) }),
  } as unknown as SupabaseClient;
}

function recordingDb(rows: Record<string, unknown>[]): SupabaseClient {
  return {
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        rows.push(row);
        return { data: null, error: null };
      },
    }),
  } as unknown as SupabaseClient;
}

describe('writeJobLog — never throws', () => {
  it('resolves when the INSERT returns an error', async () => {
    await assert.doesNotReject(() =>
      writeJobLog({
        supabase: erroringDb(),
        queue: 'file',
        jobName: 'upload_batch',
        status: 'completed',
        durationMs: 1200,
      }),
    );
  });

  it('resolves when the INSERT rejects outright', async () => {
    await assert.doesNotReject(() =>
      writeJobLog({
        supabase: throwingDb(),
        queue: 'task',
        jobName: 'task_reminder',
        status: 'failed',
      }),
    );
  });
});

describe('writeJobLog — duration handling', () => {
  /**
   * NULL, never 0. A fabricated zero would claim an instantaneous job and drag
   * every average toward a value nothing ever took — the same rule the Sheets
   * performance layer's blank cells follow.
   */
  it('writes NULL when no duration was measured', async () => {
    const rows: Record<string, unknown>[] = [];
    await writeJobLog({
      supabase: recordingDb(rows),
      queue: 'membership',
      jobName: 'boost_expiry',
      status: 'completed',
    });
    assert.equal(rows[0]!.duration_ms, null);
  });

  it('writes NULL for a negative duration rather than clamping it to 0', async () => {
    // A clock adjustment between processedOn and finishedOn. "Not measurable"
    // is the honest answer; 0 would be a fabricated instantaneous job.
    const rows: Record<string, unknown>[] = [];
    await writeJobLog({
      supabase: recordingDb(rows),
      queue: 'file',
      jobName: 'ocr_image',
      status: 'completed',
      durationMs: -50,
    });
    assert.equal(rows[0]!.duration_ms, null);
  });

  it('floors a fractional duration — the column is INT', async () => {
    const rows: Record<string, unknown>[] = [];
    await writeJobLog({
      supabase: recordingDb(rows),
      queue: 'sheets',
      jobName: 'sheets_sync',
      status: 'completed',
      durationMs: 1234.9,
    });
    assert.equal(rows[0]!.duration_ms, 1234);
  });

  it('writes NULL for NaN/Infinity', async () => {
    const rows: Record<string, unknown>[] = [];
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      await writeJobLog({
        supabase: recordingDb(rows),
        queue: 'file',
        jobName: 'finalize_scan',
        status: 'completed',
        durationMs: bad,
      });
    }
    assert.deepEqual(
      rows.map((r) => r.duration_ms),
      [null, null],
    );
  });
});
