import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { taskRowKey, toSheetRows, urgencyLabel } from './sheets-row';
import { URGENCIES } from './sheets-workspace.service';
import type { TaskWithDetails } from './task.service';

/**
 * Part B regression: a multi task must produce ONE SHEET ROW PER SUB-ITEM,
 * each carrying that item's own deadline, assignees and review state, keyed
 * `{taskId}-{itemId}` — while single/recurring tasks keep their original
 * bare-task-id row so every sheet already in the field keeps matching.
 *
 * NOTE: imports task.service (config at import time) — run the suite with
 * `--env-file=../../.env`, same as the security tests.
 */

const T = '11111111-2222-3333-4444-555555555555';
const I1 = 'aaaaaaaa-1111-2222-3333-444444444444';
const I2 = 'bbbbbbbb-1111-2222-3333-444444444444';

function assignee(uid: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id: `as-${uid}`, task_item_id: '', line_uid: uid, display_name: name,
    picture_url: null, accepted_at: null, done_at: null, done_note: null,
    ...over,
  };
}

function item(id: string, title: string, over: Record<string, unknown> = {}) {
  return {
    id, task_id: T, title, description: null, deadline: null,
    status: 'pending', sort_order: 0, deleted_at: null,
    submitted_at: null, rejected_at: null, rejection_note: null, submission_note: null,
    assignees: [] as ReturnType<typeof assignee>[],
    ...over,
  };
}

function task(over: Record<string, unknown> = {}): TaskWithDetails {
  return {
    id: T, title: 'จัดงานสัมมนา', type: 'multi', status: 'pending',
    group_line_id: 'G1', owner_line_uid: null, is_personal: false,
    created_by_line_uid: 'U9', global_deadline: '2026-08-20T11:00:00.000Z',
    recurrence_rule: null, deleted_at: null,
    created_at: '2026-08-01T02:00:00.000Z',
    items: [], links: [], files: [],
    ...over,
  } as unknown as TaskWithDetails;
}

describe('taskRowKey', () => {
  test('bare task id for task-level rows, composite for item rows', () => {
    assert.equal(taskRowKey(T), T);
    assert.equal(taskRowKey(T, I1), `${T}-${I1}`);
  });

  test('an item key can never collide with a bare task UUID', () => {
    // A UUID is 36 chars; the composite is 73 — length alone separates them,
    // which is what keeps the historical dedup and row matching unambiguous.
    assert.notEqual(taskRowKey(T, I1).length, T.length);
  });
});

describe('toSheetRows — multi tasks fan out per sub-item', () => {
  const multi = task({
    items: [
      item(I1, 'จองสถานที่', {
        deadline: '2026-08-10T10:00:00.000Z',
        assignees: [assignee('U1', 'สมชาย')],
      }),
      item(I2, 'ทำสไลด์', {
        status: 'submitted',
        submitted_at: '2026-08-05T03:00:00.000Z',
        assignees: [assignee('U2', 'สมหญิง'), assignee('U3', 'มานี', { done_at: '2026-08-04T03:00:00.000Z' })],
      }),
    ],
  });
  const rows = toSheetRows(multi, 'หัวหน้า', false);

  test('one row per sub-item, keyed {taskId}-{itemId}', () => {
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.key), [taskRowKey(T, I1), taskRowKey(T, I2)]);
    rows.forEach((r) => assert.equal(r.taskId, T));
  });

  test('ชื่องาน is "parent - sub-item"', () => {
    assert.equal(rows[0]!.title, 'จัดงานสัมมนา - จองสถานที่');
    assert.equal(rows[1]!.title, 'จัดงานสัมมนา - ทำสไลด์');
  });

  test("each row carries the item's OWN deadline, falling back to the task's", () => {
    assert.equal(rows[0]!.deadlineAt, '2026-08-10T10:00:00.000Z');
    assert.equal(rows[1]!.deadlineAt, '2026-08-20T11:00:00.000Z'); // global fallback
    assert.equal(rows[0]!.deadline, '10/08/2026 17:00'); // Bangkok wall clock
  });

  test("each row carries the item's OWN assignees, not the union", () => {
    assert.equal(rows[0]!.assignees, 'สมชาย');
    assert.equal(rows[1]!.assignees, 'สมหญิง, มานี');
  });

  test("each row carries the item's OWN status and progress", () => {
    assert.equal(rows[0]!.status, 'pending');
    assert.equal(rows[1]!.status, 'submitted');
    assert.equal(rows[0]!.progress, '░░░░░ 0%');
    assert.equal(rows[1]!.progress, '▓▓▓░░ 50%'); // 1 of 2 assignees done
  });

  test('updatedAt is per-item: an untouched item shows creation time', () => {
    assert.equal(rows[0]!.updatedAt, '01/08/2026 09:00'); // created_at, Bangkok
    assert.equal(rows[1]!.updatedAt, '05/08/2026 10:00'); // its submitted_at
  });

  test('doneAt stays null until the ITEM itself is done', () => {
    assert.equal(rows[1]!.doneAt, null); // one assignee done ≠ item done
  });
});

describe('urgencyLabel — creation urgency reaches column K (Part G)', () => {
  test('maps every canonical key onto the workspace label, most→least urgent', () => {
    assert.deepEqual(
      (['urgent_max', 'urgent', 'normal', 'relaxed'] as const).map(urgencyLabel),
      URGENCIES,
    );
  });

  test('no urgency chosen → empty (the sync then writes the ปกติ default)', () => {
    assert.equal(urgencyLabel(null), '');
    assert.equal(urgencyLabel(undefined), '');
  });

  test('a task created with urgency carries its label on every row', () => {
    const rows = toSheetRows(
      task({
        type: 'single',
        urgency: 'urgent_max',
        items: [item(I1, 'งานร้อน', { assignees: [assignee('U1', 'สมชาย')] })],
      }),
      'หัวหน้า',
      false,
    );
    assert.equal(rows[0]!.urgency, URGENCIES[0]);
  });
});

describe('toSheetRows — single and recurring keep the legacy single row', () => {
  test('a single task is one row keyed by the bare task id', () => {
    const single = task({
      type: 'single',
      items: [item(I1, 'จัดงานสัมมนา', { assignees: [assignee('U1', 'สมชาย')] })],
    });
    const rows = toSheetRows(single, 'หัวหน้า', false);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.key, T);
    assert.equal(rows[0]!.title, 'จัดงานสัมมนา'); // no item suffix
  });

  test('a multi task with zero live items degrades to a task-level row', () => {
    const rows = toSheetRows(task({ items: [] }), 'หัวหน้า', false);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.key, T);
  });
});
