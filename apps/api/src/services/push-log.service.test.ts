import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { pushTargetKind, writePushLog } from './push-log.service';

/**
 * push_log (migration 060), and the ONE property that makes it safe to put
 * inside pushMessage(): it never throws.
 *
 * That is not tidiness. writePushLog runs immediately after a push has been
 * DELIVERED. A rejection there would fail the BullMQ job, and the retry would
 * send the message a second time — a logbook that can duplicate a user's
 * messages is worse than no logbook. It also runs from the upload worker's
 * 'failed' event listener, where a rejection becomes an unhandledRejection and
 * workers/index.ts exits(1) on those.
 *
 * So the tests below hammer the failure paths, not the happy one.
 */

/** A client whose insert returns a PostgREST error object (table missing, RLS, …). */
function erroringDb(rows?: Record<string, unknown>[]): SupabaseClient {
  return {
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        rows?.push(row);
        return { data: null, error: { message: 'relation "push_log" does not exist' } };
      },
    }),
  } as unknown as SupabaseClient;
}

/** A client whose insert REJECTS — a dropped connection rather than a query error. */
function throwingDb(): SupabaseClient {
  return {
    from: () => ({
      insert: () => Promise.reject(new Error('ECONNRESET')),
    }),
  } as unknown as SupabaseClient;
}

/** A client that throws before `from` even returns a builder. */
function brokenClient(): SupabaseClient {
  return {
    from: () => {
      throw new Error('client is not initialised');
    },
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

describe('writePushLog — never throws', () => {
  it('resolves when the INSERT returns an error (migration 060 unapplied)', async () => {
    await assert.doesNotReject(() =>
      writePushLog({
        supabase: erroringDb(),
        toId: 'Cgroup123',
        context: 'task_reminder',
        messageCount: 2,
        status: 'sent',
        httpStatus: 200,
      }),
    );
  });

  it('resolves when the INSERT rejects outright (connection dropped)', async () => {
    await assert.doesNotReject(() =>
      writePushLog({
        supabase: throwingDb(),
        toId: 'Uuser123',
        context: 'diary_sweep',
        messageCount: 1,
        status: 'failed',
        error: 'boom',
      }),
    );
  });

  it('resolves when the client itself is unusable', async () => {
    await assert.doesNotReject(() =>
      writePushLog({
        supabase: brokenClient(),
        toId: 'Uuser123',
        context: 'admin_alert',
        messageCount: 1,
        status: 'blocked_flag',
      }),
    );
  });
});

describe('writePushLog — row shape', () => {
  it('writes SQL NULL, not the string "undefined", for the optional columns', async () => {
    const rows: Record<string, unknown>[] = [];
    await writePushLog({
      supabase: recordingDb(rows),
      toId: 'Cgroup123',
      context: 'task_notify',
      messageCount: 1,
      status: 'blocked_flag',
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.ref_id, null);
    assert.equal(rows[0]!.http_status, null);
    assert.equal(rows[0]!.error, null);
  });

  it('truncates a long error rather than letting the insert fail on length', async () => {
    const rows: Record<string, unknown>[] = [];
    await writePushLog({
      supabase: recordingDb(rows),
      toId: 'Uuser123',
      context: 'task_reminder',
      messageCount: 1,
      status: 'failed',
      error: 'x'.repeat(5000),
    });

    assert.equal(String(rows[0]!.error).length, 500);
  });
});

describe('pushTargetKind', () => {
  /**
   * C IS A GROUP, R IS A ROOM. This is LINE's own convention and it matches
   * chatScope() in line.service.ts, which resolves a C id to the /group/…
   * endpoint. Getting it backwards would label every group push in the product
   * as a room on the admin page while every other subsystem called it a group.
   */
  it('maps U to user, C to group, R to room', () => {
    assert.equal(pushTargetKind('U1234567890abcdef'), 'user');
    assert.equal(pushTargetKind('C1234567890abcdef'), 'group');
    assert.equal(pushTargetKind('R1234567890abcdef'), 'room');
  });

  it('falls back to group for anything unrecognised, so the CHECK cannot reject the row', () => {
    assert.equal(pushTargetKind('X999'), 'group');
    assert.equal(pushTargetKind(''), 'group');
  });
});
