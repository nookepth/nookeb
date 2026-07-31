import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { acceptHours, taskRowKey, toSheetRows, urgencyLabel } from './sheets-row';
import { extensionUpdates } from './google-sheets.service';
import { progressForStatus, URGENCIES } from './sheets-workspace.service';
import type { TaskWithDetails } from './task.service';
import type { TaskItemStatus } from '@nookeb/shared';

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
    // Progress is the item's PIPELINE STAGE, not its assignee tally. The second
    // item has 1 of 2 assignees done but has been submitted for review, so it
    // reads 75% — the old assignee ratio said 50% and, worse, said 0% for any
    // one-assignee item no matter how far along it actually was.
    assert.equal(rows[0]!.progress, '▓░░░░ 25%');
    assert.equal(rows[1]!.progress, '▓▓▓▓░ 75%');
  });

  test('updatedAt is per-item: an untouched item shows creation time', () => {
    assert.equal(rows[0]!.updatedAt, '01/08/2026 09:00'); // created_at, Bangkok
    assert.equal(rows[1]!.updatedAt, '05/08/2026 10:00'); // its submitted_at
  });

  test('doneAt stays null until the ITEM itself is done', () => {
    assert.equal(rows[1]!.doneAt, null); // one assignee done ≠ item done
  });
});

/**
 * Part C regression. Progress used to be (assignees done ÷ assignees total),
 * which on the one-assignee rows that dominate real sheets could only ever be
 * 0% or 100% — a task in review reported the same 0% as one nobody had opened.
 * Every status must now map to its own stage, and the row builder must agree
 * with the calc sheet's independent derivation for all six.
 */
describe('resolveProgress — every status maps to its pipeline stage', () => {
  const EXPECTED: [TaskItemStatus, string][] = [
    ['cancelled', '░░░░░ 0%'],
    ['pending', '▓░░░░ 25%'],
    ['in_progress', '▓▓▓░░ 50%'],
    ['rejected', '▓▓▓░░ 50%'],
    ['submitted', '▓▓▓▓░ 75%'],
    ['done', '▓▓▓▓▓ 100%'],
  ];

  EXPECTED.forEach(([status, bar]) => {
    test(`an item at ${status} reads ${bar}`, () => {
      assert.equal(progressForStatus(status), bar);
      const rows = toSheetRows(
        task({ items: [item(I1, 'ก', { status, assignees: [assignee('U1', 'สมชาย')] })] }),
        'หัวหน้า',
        false,
      );
      assert.equal(rows[0]!.progress, bar);
    });
  });

  test('no status shares 0% with a task that is merely unstarted', () => {
    // The actual complaint: กำลังทำ and รอตรวจ both showed 0%. Only ยกเลิก —
    // which is off the belt entirely — may read zero.
    const zero = EXPECTED.filter(([, bar]) => bar.endsWith(' 0%')).map(([s]) => s);
    assert.deepEqual(zero, ['cancelled']);
  });

  test('progress never regresses as a task moves down the pipeline', () => {
    const order: TaskItemStatus[] = ['pending', 'in_progress', 'submitted', 'done'];
    const pct = order.map((s) => Number(/(\d+)%$/.exec(progressForStatus(s))![1]));
    pct.forEach((p, i) => {
      if (i > 0) assert.ok(p > pct[i - 1]!, `${order[i]} (${p}%) did not advance`);
    });
  });

  test('ตีกลับ falls back to the work stage rather than crediting review', () => {
    assert.equal(progressForStatus('rejected'), progressForStatus('in_progress'));
  });

  test('an unrecognised status renders blank, never a misleading 0%', () => {
    // 'ลบแล้ว' rows reach the sheet through row.deleted, not through this map.
    assert.equal(progressForStatus('ไม่มีจริง' as TaskItemStatus), '');
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

/**
 * PART A (layout v6) — ⏱ เวลาตอบรับ, master column S.
 *
 * `accepted_at` has existed on task_assignees since migration 036 and is
 * stamped by markAssigneeAccepted on every รับทราบ (LINE postback and
 * `POST …/items/:itemId/accept` alike). It was simply never carried into the
 * sheet, so no formula could reach it. Nothing about it is new or backfilled:
 * the production table holds 6 acknowledged rows out of 17 assignee rows, with
 * real lags from 20 seconds to 3.4 hours, which is exactly the spread these
 * tests pin down.
 *
 * The failure this guards against is the tempting one: emitting 0 for a row
 * nobody has acknowledged. 0 is a claim ("answered instantly"), and it would
 * quietly pull every per-person average on the performance tab toward zero.
 */
describe('acceptHours — assignment → first รับทราบ', () => {
  const ASSIGNED = '2026-08-01T02:00:00.000Z';

  test('two hours after assignment reads 2', () => {
    assert.equal(acceptHours(ASSIGNED, '2026-08-01T04:00:00.000Z'), 2);
  });

  test('never acknowledged is BLANK, never 0 and never an error', () => {
    const blank = acceptHours(ASSIGNED, null);
    assert.equal(blank, '');
    assert.notEqual(blank, 0);
    // The distinction the whole column rests on: '' is skipped by AVERAGE and
    // by ISNUMBER, 0 is averaged in as a perfect score.
    assert.equal(typeof blank, 'string');
  });

  test('a missing assignment stamp is blank too, not a huge number', () => {
    assert.equal(acceptHours(null, '2026-08-01T04:00:00.000Z'), '');
    assert.equal(acceptHours(undefined, undefined), '');
  });

  test('keeps two decimals, so a fast reply is not rounded away to 0', () => {
    // A real production row: acknowledged 20 seconds after creation. At one
    // decimal this would read 0.0 and be indistinguishable from "never".
    assert.equal(acceptHours(ASSIGNED, '2026-08-01T02:00:20.000Z'), 0.01);
    assert.equal(acceptHours(ASSIGNED, '2026-08-01T05:24:00.000Z'), 3.4);
  });

  test('clock skew clamps to 0 rather than reporting negative responsiveness', () => {
    assert.equal(acceptHours(ASSIGNED, '2026-08-01T01:00:00.000Z'), 0);
  });

  test('an unparseable stamp is blank, not NaN', () => {
    assert.equal(acceptHours(ASSIGNED, 'ไม่ใช่วันที่'), '');
  });
});

describe('toSheetRows — acceptHours per row', () => {
  const CREATED = '2026-08-01T02:00:00.000Z';

  test('a single task measures from creation to its assignee acceptance', () => {
    const rows = toSheetRows(
      task({
        type: 'single',
        created_at: CREATED,
        items: [item(I1, 'งาน', {
          assignees: [assignee('U1', 'สมชาย', { accepted_at: '2026-08-01T04:00:00.000Z' })],
        })],
      }),
      'หัวหน้า',
      false,
    );
    assert.equal(rows[0]!.acceptHours, 2);
  });

  test('an unacknowledged task leaves the cell blank', () => {
    const rows = toSheetRows(
      task({ type: 'single', created_at: CREATED, items: [item(I1, 'งาน', { assignees: [assignee('U1', 'สมชาย')] })] }),
      'หัวหน้า',
      false,
    );
    assert.equal(rows[0]!.acceptHours, '');
  });

  test('several assignees: the EARLIEST acceptance, matching when the row moved', () => {
    // รับทราบ promotes the item to กำลังทำ on the FIRST tap, so the first stamp
    // is the moment the sheet's own สถานะ column changed. Taking the latest
    // would print a number the row's ประวัติสถานะ contradicts.
    const rows = toSheetRows(
      task({
        type: 'single',
        created_at: CREATED,
        items: [item(I1, 'งาน', {
          assignees: [
            assignee('U1', 'สมชาย', { accepted_at: '2026-08-01T07:00:00.000Z' }),
            assignee('U2', 'สมหญิง', { accepted_at: '2026-08-01T03:00:00.000Z' }),
          ],
        })],
      }),
      'หัวหน้า',
      false,
    );
    assert.equal(rows[0]!.acceptHours, 1);
  });

  /**
   * PART A.3 — the historical backfill needs no separate code path and no data
   * migration. historicalSync builds its rows with this same toSheetRows and
   * appends them through appendTaskRows → extensionUpdates, so a task created
   * and acknowledged long before column S existed populates it on the first
   * backfill. Shaped from a real production row (created 20:10:57, acknowledged
   * 20:11:17 the same evening).
   */
  test('a task acknowledged before column S existed still backfills a value', () => {
    const rows = toSheetRows(
      task({
        type: 'single',
        created_at: '2026-07-31T20:10:57.868Z',
        items: [item(I1, 'งานเก่า', {
          status: 'done',
          assignees: [assignee('U1', 'สมชาย', {
            accepted_at: '2026-07-31T20:11:17.926Z',
            done_at: '2026-07-31T20:12:54.667Z',
          })],
        })],
      }),
      'หัวหน้า',
      false,
    );
    assert.equal(rows[0]!.acceptHours, 0.01);
  });

  test('a multi task measures each sub-item separately', () => {
    const rows = toSheetRows(
      task({
        created_at: CREATED,
        items: [
          item(I1, 'จองสถานที่', {
            assignees: [assignee('U1', 'สมชาย', { accepted_at: '2026-08-01T05:00:00.000Z' })],
          }),
          item(I2, 'ทำสไลด์', { assignees: [assignee('U2', 'สมหญิง')] }),
        ],
      }),
      'หัวหน้า',
      false,
    );
    assert.equal(rows[0]!.acceptHours, 3);
    // One acknowledged sub-item must not make its untouched sibling look
    // acknowledged — the whole reason multi tasks get one row each.
    assert.equal(rows[1]!.acceptHours, '');
  });
});

describe('extensionUpdates — column S reaches the sheet through the K–S write', () => {
  const base = {
    key: 'k', taskId: 't', urgency: '', title: 'ชื่อ', description: '', type: 'single' as const,
    deadline: '', createdBy: 'หัวหน้า', assignees: 'สมชาย', status: 'pending' as const,
    updatedAt: '', deleted: false, progress: '', links: '',
    createdAt: '2026-08-01T02:00:00.000Z', doneAt: null, deadlineAt: null,
  };
  const prior = { previousStatus: '', urgency: '🟡 ปกติ', log: '' };
  const dateBlock = (row: typeof base & { acceptHours: number | '' }) =>
    extensionUpdates(5, row, prior).find((u) => String(u.range).includes('P6:S6'));

  test('the date block spans P:S and carries the hours as its fourth value', () => {
    const block = dateBlock({ ...base, acceptHours: 2 });
    assert.ok(block, 'no P:S write was emitted');
    assert.equal(block!.values![0]!.length, 4);
    assert.equal(block!.values![0]![3], 2);
  });

  test('an unacknowledged row writes an empty cell, not a zero', () => {
    const block = dateBlock({ ...base, acceptHours: '' });
    assert.equal(block!.values![0]![3], '');
  });

  test('S is written in the same batch as P–R, never as a second pass', () => {
    // Two writes would let a row carry this sync's deadline next to the last
    // sync's acknowledgement time if the second call failed.
    const ranges = extensionUpdates(5, { ...base, acceptHours: 1 }, prior).map((u) => String(u.range));
    assert.equal(ranges.filter((r) => /![P-S]\d/.test(r)).length, 1);
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
