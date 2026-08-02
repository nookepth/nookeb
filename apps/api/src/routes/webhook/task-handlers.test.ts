import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { handleTaskPostback, type TaskWebhookEvent } from './task-handlers';
import { sheetsSyncJobOptions } from '../../services/sheetsQueue';

/**
 * Regression tests for the two bugs that made every LINE-side status change
 * invisible in the Google Sheet mirror (2026-08-01):
 *
 *  1. handleTaskPostback (รับทราบ / เสร็จแล้ว) wrote to the DB but never
 *     enqueued a sheets sync — unlike the HTTP task routes, a webhook postback
 *     has no onResponse hook to do it for free.
 *  2. enqueueSheetsSync's stable jobId sat in BullMQ's COMPLETED set (retention
 *     count: 100), and BullMQ silently rejects an add whose jobId still exists
 *     there — so after a task's create-sync completed, every later upsert for
 *     that task was dropped. removeOnComplete/removeOnFail: true is the fix.
 *
 * NOTE: this file imports modules that read config at import time, so the
 * suite must run with `--env-file=../../.env` (same as the security tests).
 */

// ---- a minimal chainable Supabase fake -------------------------------------
// Resolves every select from a fixture table, records every update, and keeps
// the chain surface exactly as task.service uses it (eq/is/in/order/
// maybeSingle/select). Filters are ignored on purpose: fixtures hold a single
// task, so "all rows of the table" is the correct answer to every query.

interface UpdateCall {
  table: string;
  values: Record<string, unknown>;
}

function fakeSupabase(tables: Record<string, Record<string, unknown>[]>) {
  const updates: UpdateCall[] = [];
  const from = (table: string) => {
    const state = { op: 'select' as 'select' | 'update', values: {} as Record<string, unknown>, single: false };
    const builder: Record<string, unknown> = {};
    const chain = (name: string) => {
      builder[name] = (...args: unknown[]) => {
        if (name === 'update') {
          state.op = 'update';
          state.values = args[0] as Record<string, unknown>;
        }
        if (name === 'maybeSingle' || name === 'single') state.single = true;
        return builder;
      };
    };
    ['select', 'eq', 'is', 'in', 'order', 'update', 'maybeSingle', 'single', 'limit'].forEach(chain);
    builder.then = (resolve: (v: unknown) => unknown) => {
      if (state.op === 'update') {
        updates.push({ table, values: state.values });
        return resolve({ data: [{ id: 'updated-row' }], error: null });
      }
      const rows = tables[table] ?? [];
      return resolve({ data: state.single ? (rows[0] ?? null) : rows, error: null });
    };
    return builder;
  };
  return { supabase: { from } as never, updates };
}

const appWith = (supabase: never): FastifyInstance =>
  ({ supabase, log: { error: () => {} } }) as unknown as FastifyInstance;

function fixtures() {
  return {
    tasks: [{
      id: 'T1', title: 'ทำสไลด์', status: 'pending', type: 'single',
      group_line_id: 'G1', owner_line_uid: null, is_personal: false,
      created_by_line_uid: 'U9', global_deadline: null, deleted_at: null,
      created_at: '2026-08-01T02:00:00.000Z', recurrence_rule: null,
    }],
    task_items: [{
      id: 'I1', task_id: 'T1', title: 'ทำสไลด์', status: 'pending',
      deadline: null, sort_order: 0, deleted_at: null,
      submitted_at: null, rejected_at: null,
    }],
    // Two assignees so a single เสร็จแล้ว tap cannot complete the task (keeps
    // the test away from cancelReminders' real BullMQ queue).
    task_assignees: [
      { id: 'A1', task_item_id: 'I1', line_uid: 'U1', display_name: 'คนทำ', done_at: null, accepted_at: null },
      { id: 'A2', task_item_id: 'I1', line_uid: 'U2', display_name: 'เพื่อน', done_at: null, accepted_at: null },
    ],
    task_links: [],
    task_files: [],
  };
}

const groupEvent = (data: string): TaskWebhookEvent => ({
  replyToken: 'rt-1',
  source: { type: 'group', userId: 'U1', groupId: 'G1' },
  postback: { data },
});

function run(data: string, tables = fixtures()) {
  const { supabase, updates } = fakeSupabase(tables);
  const synced: [string, string][] = [];
  const replies: string[] = [];
  const handled = handleTaskPostback(appWith(supabase), groupEvent(data), {
    enqueueSync: (taskId, action) => synced.push([taskId, action]),
    reply: async (_token, messages) => {
      replies.push(JSON.stringify(messages));
      return undefined as never;
    },
  });
  return { handled, synced, replies, updates };
}

describe('handleTaskPostback — every transition mirrors to the sheet', () => {
  test('รับทราบ (task_accept) enqueues an upsert for that task', async () => {
    const { handled, synced, replies } = run('action=task_accept&taskId=T1');
    assert.equal(await handled, true);
    assert.deepEqual(synced, [['T1', 'upsert']]);
    // The รับทราบ confirmation reply was removed per product decision — the
    // postback still writes and syncs, it just says nothing back.
    assert.equal(replies.length, 0);
  });

  test('รับทราบ promotes the pending item AND task to กำลังทำ', async () => {
    const { handled, updates } = run('action=task_accept&taskId=T1');
    await handled;
    assert.ok(
      updates.some((u) => u.table === 'task_items' && u.values.status === 'in_progress'),
      `no task_items in_progress update in ${JSON.stringify(updates)}`,
    );
    assert.ok(
      updates.some((u) => u.table === 'tasks' && u.values.status === 'in_progress'),
      `no tasks in_progress update in ${JSON.stringify(updates)}`,
    );
  });

  test('เสร็จแล้ว (task_done) enqueues an upsert for that task', async () => {
    const { handled, synced, updates, replies } = run('action=task_done&taskId=T1');
    assert.equal(await handled, true);
    assert.deepEqual(synced, [['T1', 'upsert']]);
    assert.ok(updates.some((u) => u.table === 'task_assignees' && u.values.done_at));
    // The เสร็จแล้ว confirmation reply was removed per product decision, same
    // as รับทราบ above — the tap writes and syncs, it just says nothing back.
    assert.equal(replies.length, 0);
  });

  test('a non-task postback is left alone and syncs nothing', async () => {
    const { handled, synced } = run('action=something_else');
    assert.equal(await handled, false);
    assert.deepEqual(synced, []);
  });

  test('a tap on a cancelled task replies but does not sync', async () => {
    const tables = fixtures();
    tables.tasks[0]!.status = 'cancelled';
    const { handled, synced, replies } = run('action=task_accept&taskId=T1', tables);
    assert.equal(await handled, true);
    assert.deepEqual(synced, []);
    assert.equal(replies.length, 1);
  });
});

describe('sheetsSyncJobOptions — the completed-set swallow', () => {
  test('settled jobs are removed so the same task can sync again', () => {
    const opts = sheetsSyncJobOptions('T1', 'upsert');
    // With retention instead of true, the create-sync's completed job blocks
    // every later upsert for the same task — the exact Part A bug.
    assert.equal(opts.removeOnComplete, true);
    assert.equal(opts.removeOnFail, true);
  });

  test('jobId still collapses bursts per task+action while queued', () => {
    assert.equal(sheetsSyncJobOptions('T1', 'upsert').jobId, 'sheets-T1-upsert');
    assert.notEqual(
      sheetsSyncJobOptions('T1', 'upsert').jobId,
      sheetsSyncJobOptions('T1', 'delete').jobId,
    );
  });
});
