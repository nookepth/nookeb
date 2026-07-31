import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendStatusLog,
  calcFormulas,
  composeChartRequests,
  composeWorkspacePlans,
  formatHistoricalStamp,
  parseHistoricalStamp,
  progressBar,
  serializeHistoricalStamp,
  sizeOf,
  toSheetSerial,
  CALC_PERF,
  DASH_TAB,
  HISTORICAL_STAMP_A1,
  STAGE_PROGRESS,
  type TabPlan,
} from './sheets-workspace.service';
import { STATUS_LABEL } from './google-sheets.service';
import type { TaskItemStatus } from '@nookeb/shared';

/**
 * The pure half of the workspace builder. These three functions decide what the
 * sheet actually SHOWS, and two of them are silently destructive when wrong:
 * a bad serial shifts every deadline (and with it "เกินกำหนด"), and a log that
 * appends on every sync would bury the real history under duplicates.
 */

describe('toSheetSerial', () => {
  test('matches the serial Sheets itself uses for a known date', () => {
    // 2000-01-01 is 36526 in the 1899-12-30 epoch Sheets/Excel share. Anchored
    // on a modern date on purpose: Bangkok ran on +06:42 LMT until 1920, so a
    // 19th-century anchor would be testing tzdata history, not this function.
    assert.equal(toSheetSerial('1999-12-31T17:00:00.000Z'), 36526);
  });

  test('converts a UTC instant to the Bangkok clock reading, not UTC', () => {
    // 02:00Z on 5 Aug = 09:00 Bangkok the same day → .375 of a day, not .0833.
    const serial = toSheetSerial('2026-08-05T02:00:00.000Z');
    assert.equal(typeof serial, 'number');
    assert.equal(Number(serial) % 1, 9 / 24);
  });

  test('a late-evening UTC instant lands on the NEXT Bangkok day', () => {
    // 18:00Z = 01:00 Bangkok tomorrow. Truncating to the day must move forward,
    // or the calendar puts the task on the wrong square.
    const evening = Number(toSheetSerial('2026-08-05T18:00:00.000Z'));
    const morning = Number(toSheetSerial('2026-08-05T02:00:00.000Z'));
    assert.equal(Math.floor(evening) - Math.floor(morning), 1);
  });

  test('whole days apart stay whole days apart', () => {
    const a = Number(toSheetSerial('2026-08-05T02:00:00.000Z'));
    const b = Number(toSheetSerial('2026-08-12T02:00:00.000Z'));
    assert.equal(b - a, 7);
  });

  test('empty for null, undefined and unparseable input', () => {
    assert.equal(toSheetSerial(null), '');
    assert.equal(toSheetSerial(undefined), '');
    assert.equal(toSheetSerial('ไม่ใช่วันที่'), '');
  });
});

describe('progressBar', () => {
  test('renders five blocks with the percentage', () => {
    assert.equal(progressBar(0, 4), '░░░░░ 0%');
    assert.equal(progressBar(2, 4), '▓▓▓░░ 50%');
    assert.equal(progressBar(4, 4), '▓▓▓▓▓ 100%');
  });

  test('is blank when the task has no items to measure', () => {
    assert.equal(progressBar(0, 0), '');
  });

  test('clamps a done count that overshoots the total', () => {
    assert.equal(progressBar(9, 4), '▓▓▓▓▓ 100%');
  });
});

describe('appendStatusLog', () => {
  const at = new Date('2026-08-05T02:00:00.000Z'); // 09:00 Bangkok

  test('records a transition newest-first', () => {
    const out = appendStatusLog('', 'รอดำเนินการ', 'กำลังทำ', at);
    assert.equal(out, '05/08 09:00  รอดำเนินการ → กำลังทำ');
  });

  test('labels the first sighting instead of a fake transition', () => {
    assert.equal(appendStatusLog('', null, 'รอดำเนินการ', at), '05/08 09:00  เริ่มติดตาม: รอดำเนินการ');
  });

  test('returns the history untouched when the status did not move', () => {
    // The sync rewrites a row for edits that have nothing to do with status —
    // appending there would grow the cell on every unrelated save.
    const existing = '01/08 10:00  รอดำเนินการ → กำลังทำ';
    assert.equal(appendStatusLog(existing, 'กำลังทำ', 'กำลังทำ', at), existing);
  });

  test('keeps only the 12 most recent lines', () => {
    const existing = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const out = appendStatusLog(existing, 'กำลังทำ', 'เสร็จแล้ว', at).split('\n');
    assert.equal(out.length, 12);
    assert.equal(out[0], '05/08 09:00  กำลังทำ → เสร็จแล้ว');
    assert.equal(out[1], 'line 0');
  });
});

describe('calcFormulas — master references survive row insertion', () => {
  const row = calcFormulas()[0]!;

  /**
   * The bug this guards. The sync appends task rows, and Sheets rewrites every
   * DIRECT reference at or below an inserted row — so `'งานของฉัน'!J2:J` became
   * J3:J, J4:J, … one row per task, until _ข้อมูลคำนวณ read from below its own
   * data and every single view reported zero. INDIRECT takes a string, which no
   * insertion can rewrite. If this test fails, the whole workspace silently
   * goes blank again after the next few tasks.
   */
  test('no formula reaches the master with a direct reference', () => {
    const direct = row.filter((f) => /(^|[^"])'งานของฉัน'!/.test(f));
    assert.deepEqual(direct, []);
  });

  test('every master reference is wrapped in INDIRECT', () => {
    const refs = row.join('\n').match(/'งานของฉัน'!/g) ?? [];
    const wrapped = row.join('\n').match(/INDIRECT\("'งานของฉัน'!/g) ?? [];
    assert.ok(refs.length > 0, 'expected the calc sheet to read the master at all');
    assert.equal(wrapped.length, refs.length);
  });

  test('the row gate still points at row 2, not further down', () => {
    assert.ok(row[0]!.includes(`INDIRECT("'งานของฉัน'!$J$2:$J")`), row[0]);
  });

  test('produces one formula per calc column', () => {
    assert.equal(row.length, 30); // A–AD, see CALC_HEADERS
  });

  test('each formula is a spilling ARRAYFORMULA', () => {
    row.forEach((f) => assert.ok(f.startsWith('=ARRAYFORMULA(IF(INDIRECT('), f));
  });
});

describe('composeWorkspacePlans — the nav offset', () => {
  // Deterministic fake gids: the tab's position in the list.
  const TITLES = [
    '_ตัวเลือก', '_ข้อมูลคำนวณ', '📊 ภาพรวม', '⚡ ความสำคัญ', '🔄 ติดตามสถานะ',
    '👥 รายงานทีม', '🗓️ ปฏิทิน', '📈 วิเคราะห์', '📅 สรุปงาน', '✅ งานเสร็จ',
    '📊 รายงานผลการทำงานรายบุคคล', '➕ วิธีสั่งงาน',
  ];
  const gid = (t: string) => {
    const i = TITLES.indexOf(t);
    if (i === -1) throw new Error(`unknown tab ${t}`);
    return 100 + i;
  };
  const plans = composeWorkspacePlans(gid, 0);
  const byTitle = new Map<string, TabPlan>(plans);
  const NAV_TABS = [
    '📊 ภาพรวม', '⚡ ความสำคัญ', '🔄 ติดตามสถานะ', '👥 รายงานทีม',
    '🗓️ ปฏิทิน', '📈 วิเคราะห์', '📅 สรุปงาน', '✅ งานเสร็จ',
    '📊 รายงานผลการทำงานรายบุคคล', '➕ วิธีสั่งงาน',
  ];

  const firstRow = (a1: string) => Number(/([A-Z]+)(\d+)/.exec(a1)![2]);

  test('every visible tab writes a nav strip into row 1', () => {
    NAV_TABS.forEach((t) => {
      const nav = byTitle.get(t)!.values[0]!;
      assert.equal(firstRow(nav.range), 1, t);
      assert.equal(nav.rows[0]!.length, 9, t);
    });
  });

  test('nav links point at the gid of the tab they name', () => {
    const nav = byTitle.get('📊 ภาพรวม')!.values[0]!.rows[0]! as string[];
    assert.ok(nav[0]!.includes(`#gid=${gid('📊 ภาพรวม')}`), nav[0]);
    assert.ok(nav[1]!.includes(`#gid=${gid('⚡ ความสำคัญ')}`), nav[1]);
    // v6 added the per-person report between งานเสร็จ and the master tab.
    assert.ok(nav[7]!.includes(`#gid=${gid('📊 รายงานผลการทำงานรายบุคคล')}`), nav[7]);
    // The last link goes to the master tab, whose gid is passed separately.
    assert.ok(nav[8]!.includes('#gid=0'), nav[8]);
  });

  test('no view content is left in row 1, where the nav now lives', () => {
    NAV_TABS.forEach((t) => {
      byTitle.get(t)!.values.slice(1).forEach((v) => {
        assert.ok(firstRow(v.range) > 1, `${t} ${v.range}`);
      });
    });
  });

  /**
   * The hidden tabs must NOT shift. _ข้อมูลคำนวณ's ARRAYFORMULA anchors at A2 are
   * what the entire workspace reads; moving them re-creates the exact drift bug
   * the INDIRECT fix above exists to prevent.
   */
  test('hidden calculation tabs are left untouched', () => {
    assert.equal(byTitle.get('_ข้อมูลคำนวณ')!.values[0]!.range, 'A1');
    const calcFormulaCell = byTitle.get('_ข้อมูลคำนวณ')!.values[1]!;
    assert.equal(calcFormulaCell.range, 'A2');
    assert.ok(String(calcFormulaCell.rows[0]![0]).startsWith('=ARRAYFORMULA('));
  });

  test('a tab narrower than the nav is widened to fit it', () => {
    assert.ok(byTitle.get('➕ วิธีสั่งงาน')!.cols >= 8);
    assert.ok(byTitle.get('🗓️ ปฏิทิน')!.cols >= 8);
  });

  test('filter formulas follow their own dropdown cell down', () => {
    // ความสำคัญ seeds its dropdown at B2 pre-shift, so the filter must read B3.
    const prio = byTitle.get('⚡ ความสำคัญ')!;
    const dropdown = prio.values.find((v) => v.range === 'A3')!;
    assert.equal(dropdown.rows[0]![1], 'ทั้งหมด');
    const view = prio.values.find((v) => String(v.rows[0]![0]).includes('ARRAY_CONSTRAIN'))!;
    assert.ok(String(view.rows[0]![0]).includes('$B$3'), String(view.rows[0]![0]).slice(0, 120));
    assert.ok(!String(view.rows[0]![0]).includes('$B$2'));
  });

  test('cross-tab references to the hidden tabs are NOT shifted', () => {
    const dash = byTitle.get('📊 ภาพรวม')!;
    const kpi = dash.values.find((v) => String(v.rows[0]![0]).includes('SUMPRODUCT'))!;
    // _ข้อมูลคำนวณ has no nav strip, so its data still starts at row 2.
    assert.ok(String(kpi.rows[0]![0]).includes(`'_ข้อมูลคำนวณ'!$A$2`), String(kpi.rows[0]![0]));
  });

  test('column widths are not shifted as if they were rows', () => {
    const dash = byTitle.get('📊 ภาพรวม')!;
    const cols = dash.requests.filter((r) =>
      r.updateDimensionProperties?.range?.dimension === 'COLUMNS');
    assert.ok(cols.length > 0);
    assert.equal(cols[0]!.updateDimensionProperties!.range!.startIndex, 0);
  });

  test('every visible tab freezes at least the nav row', () => {
    NAV_TABS.forEach((t) => {
      const frozen = byTitle.get(t)!.requests
        .filter((r) => r.updateSheetProperties?.fields === 'gridProperties.frozenRowCount')
        .pop();
      assert.ok(frozen, t);
      const n = frozen!.updateSheetProperties!.properties!.gridProperties!.frozenRowCount!;
      assert.ok(n >= 1, `${t} froze ${n}`);
    });
  });
});

describe('composeWorkspacePlans — conditional formats move with their range', () => {
  const TITLES = [
    '_ตัวเลือก', '_ข้อมูลคำนวณ', '📊 ภาพรวม', '⚡ ความสำคัญ', '🔄 ติดตามสถานะ',
    '👥 รายงานทีม', '🗓️ ปฏิทิน', '📈 วิเคราะห์', '📅 สรุปงาน', '✅ งานเสร็จ',
    '📊 รายงานผลการทำงานรายบุคคล', '➕ วิธีสั่งงาน',
  ];
  const byTitle = new Map<string, TabPlan>(
    composeWorkspacePlans((t) => 100 + TITLES.indexOf(t), 0),
  );

  const customRules = (title: string) => byTitle.get(title)!.requests
    .filter((r) => r.addConditionalFormatRule?.rule?.booleanRule?.condition?.type === 'CUSTOM_FORMULA')
    .map((r) => ({
      formula: r.addConditionalFormatRule!.rule!.booleanRule!.condition!.values![0]!.userEnteredValue!,
      startRow: r.addConditionalFormatRule!.rule!.ranges![0]!.startRowIndex!,
    }));

  /**
   * A CF custom formula is relative to the top-left of its range. If the range
   * shifts for the nav strip but the formula does not, every urgency stripe
   * paints one row off — visible, but easy to miss in review.
   */
  test('each custom formula anchors on the first row of its own range', () => {
    ['⚡ ความสำคัญ', '👥 รายงานทีม', '🗓️ ปฏิทิน'].forEach((title) => {
      const rules = customRules(title);
      assert.ok(rules.length > 0, `${title} has no custom rules`);
      rules.forEach(({ formula, startRow }) => {
        const row = Number(/\$?[A-Z]{1,2}\$?(\d+)/.exec(formula)![1]);
        // startRow is 0-based; the formula is 1-based against the same row.
        assert.equal(row, startRow + 1, `${title}: ${formula} over row index ${startRow}`);
      });
    });
  });

  test('a rule that names another sheet is never mechanically shifted', () => {
    byTitle.forEach((plan, title) => {
      plan.requests
        .filter((r) => r.addConditionalFormatRule?.rule?.booleanRule?.condition?.type === 'CUSTOM_FORMULA')
        .forEach((r) => {
          const f = r.addConditionalFormatRule!.rule!.booleanRule!.condition!.values![0]!.userEnteredValue!;
          if (f.includes('!')) {
            assert.fail(`${title} has a cross-sheet CF formula that cannot shift safely: ${f}`);
          }
        });
    });
  });
});

describe('composeWorkspacePlans — every write lands inside the grid', () => {
  const TITLES = [
    '_ตัวเลือก', '_ข้อมูลคำนวณ', '📊 ภาพรวม', '⚡ ความสำคัญ', '🔄 ติดตามสถานะ',
    '👥 รายงานทีม', '🗓️ ปฏิทิน', '📈 วิเคราะห์', '📅 สรุปงาน', '✅ งานเสร็จ',
    '📊 รายงานผลการทำงานรายบุคคล', '➕ วิธีสั่งงาน',
  ];
  const plans = composeWorkspacePlans((t) => 100 + TITLES.indexOf(t), 0);

  const colIndex = (letters: string) =>
    letters.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

  /**
   * A tab is created at a fixed size and CANNOT be resized in the same batch, so
   * a values write past the last row or column is a hard 400 from the Sheets API
   * — the whole rebuild fails and the user is left with half a workspace.
   */
  test('no value is written past the row or column count the tab is created with', () => {
    plans.forEach(([title, plan]) => {
      const size = sizeOf(title);
      plan.values.forEach((v) => {
        const cells = v.range.split(':');
        const anchor = /([A-Z]+)(\d+)/.exec(cells[0]!)!;
        const startCol = colIndex(anchor[1]!);
        const startRow = Number(anchor[2]!);

        const height = v.rows.length;
        const width = Math.max(...v.rows.map((r) => r.length));

        assert.ok(
          startRow + height - 1 <= size.rows,
          `${title}!${v.range} writes to row ${startRow + height - 1} but the tab has ${size.rows}`,
        );
        assert.ok(
          startCol + width <= size.cols,
          `${title}!${v.range} writes to column ${startCol + width} but the tab has ${size.cols}`,
        );
      });
    });
  });
});

describe('layout v4 — สั่งงาน removed, สรุปงาน picker, งานเสร็จ report', () => {
  const TITLES = [
    '_ตัวเลือก', '_ข้อมูลคำนวณ', '📊 ภาพรวม', '⚡ ความสำคัญ', '🔄 ติดตามสถานะ',
    '👥 รายงานทีม', '🗓️ ปฏิทิน', '📈 วิเคราะห์', '📅 สรุปงาน', '✅ งานเสร็จ',
    '📊 รายงานผลการทำงานรายบุคคล', '➕ วิธีสั่งงาน',
  ];
  const gid = (t: string) => {
    const i = TITLES.indexOf(t);
    if (i === -1) throw new Error(`unknown tab ${t}`);
    return 100 + i;
  };
  const plans = composeWorkspacePlans(gid, 0);
  const byTitle = new Map<string, TabPlan>(plans);
  const allText = (plan: TabPlan) =>
    plan.values.flatMap((v) => v.rows.flat()).map(String).join('\n');

  test('the สั่งงาน tab is gone from the generated set (Part E)', () => {
    assert.equal(byTitle.has('📋 สั่งงาน'), false);
  });

  test('no surviving formula references the removed สั่งงาน tab (Part E)', () => {
    // The nav labels say "วิธีสั่งงาน" as prose; what must not survive is a
    // FORMULA reference ('📋 สั่งงาน'!…), which would #REF! after the delete.
    plans.forEach(([title, plan]) => {
      assert.ok(
        !allText(plan).includes(`'📋 สั่งงาน'!`),
        `${title} still references the removed tab`,
      );
    });
  });

  test('สรุปงาน has the date/month picker and reads it, not a fixed week (Part D)', () => {
    const text = allText(byTitle.get('📅 สรุปงาน')!);
    assert.ok(text.includes('รายเดือน'), 'mode dropdown default missing');
    assert.ok(text.includes('IF($B$3="รายวัน"'), 'formulas do not read the (shifted) mode cell');
    assert.ok(!text.includes('WEEKDAY(TODAY(),3)'), 'still pinned to the current week');
  });

  test('analytics ranges are calendar-month chunks, clamped at month end (Part C)', () => {
    const text = allText(byTitle.get('📈 วิเคราะห์')!);
    assert.ok(text.includes('DATE(YEAR(TODAY()), MONTH(TODAY())+0, 1)'), 'no month anchor');
    // The 29-end chunk must clamp to the true month end, not assume 7 days…
    assert.ok(text.includes('MIN(DATE(YEAR(TODAY()), MONTH(TODAY())+0, 1)+28+7'), 'no month-end clamp');
    // …and a chunk that starts past the month end (Feb 29-31) must blank itself.
    assert.match(text, /IF\(DATE\(YEAR\(TODAY\(\)\), MONTH\(TODAY\(\)\)\+0, 1\)\+28>=DATE/);
    assert.ok(!text.includes('WEEKDAY(TODAY(),3)'), 'rolling 7-day blocks still present');
  });

  test('งานเสร็จ computes days-to-complete from real stamps only (Part H)', () => {
    const text = allText(byTitle.get('✅ งานเสร็จ')!);
    // U (done−created) gated on I (real completion instant) — no invented field.
    assert.ok(text.includes(`FILTER('_ข้อมูลคำนวณ'!$U$2:$U, '_ข้อมูลคำนวณ'!$I$2:$I<>"")`));
    assert.ok(text.includes('"เสร็จแล้ว"'));
    assert.ok(text.includes('เกิน 14 วัน'), 'distribution buckets missing');
  });

  test('chart SOURCES on nav-shifted tabs are shifted with their data', () => {
    const charts = composeChartRequests(gid);
    const ranges = (req: (typeof charts)[number]) => {
      const found: { sheetId: number; startRowIndex?: number }[] = [];
      const walk = (n: unknown): void => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (n && typeof n === 'object') {
          const o = n as Record<string, unknown>;
          if (typeof o.sheetId === 'number' && 'startRowIndex' in o) {
            found.push(o as { sheetId: number; startRowIndex?: number });
          }
          Object.values(o).forEach(walk);
        }
      };
      walk(req.addChart?.chart?.spec);
      return found;
    };
    // The analytics trend chart's table header sits at nav-free row 3; after
    // the shift its sources must start at 4 — the pre-v4 bug left them at 3,
    // reading a blank row and dropping the newest data row.
    const anaSources = charts.flatMap(ranges).filter((r) => r.sheetId === gid('📈 วิเคราะห์'));
    assert.ok(anaSources.length > 0);
    anaSources.forEach((r) => assert.ok((r.startRowIndex ?? 0) >= 4, JSON.stringify(r)));
    // _ตัวเลือก has no nav strip — its sources must NOT move off row 0.
    const confSources = charts.flatMap(ranges).filter((r) => r.sheetId === gid('_ตัวเลือก'));
    assert.ok(confSources.some((r) => (r.startRowIndex ?? 0) === 0));
  });
});

describe('layout v5 — spill footprints, stage progress, calendar exclusions', () => {
  const TITLES = [
    '_ตัวเลือก', '_ข้อมูลคำนวณ', '📊 ภาพรวม', '⚡ ความสำคัญ', '🔄 ติดตามสถานะ',
    '👥 รายงานทีม', '🗓️ ปฏิทิน', '📈 วิเคราะห์', '📅 สรุปงาน', '✅ งานเสร็จ',
    '📊 รายงานผลการทำงานรายบุคคล', '➕ วิธีสั่งงาน',
  ];
  const plans = composeWorkspacePlans((t) => 100 + TITLES.indexOf(t), 0);
  const byTitle = new Map<string, TabPlan>(plans);
  const allText = (plan: TabPlan) =>
    plan.values.flatMap((v) => v.rows.flat()).map(String).join('\n');

  const colIndex = (letters: string) =>
    letters.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

  /**
   * PART B regression — the bug that showed a bare #REF! where ความเคลื่อนไหว
   * ล่าสุด should be.
   *
   * viewFormula emits `=IFERROR(ARRAY_CONSTRAIN(SORT(FILTER(…)), rows, cols))`,
   * which SPILLS over `rows × cols` cells below and right of its anchor. Google
   * Sheets refuses to expand an array into a range where any cell already holds
   * something and reports #REF! for the whole block — and the IFERROR inside
   * the formula does NOT catch it, because a blocked spill is raised against
   * the range before the wrapped expression is evaluated. The dashboard's feed
   * was capped at 10 rows from A21, so it owned A21:D30, and '📊 กราฟสรุป' sat
   * in A30. It looked fine until the sheet held 10+ rows — which per-item rows
   * made routine — and then died with no error anywhere in the logs.
   *
   * Checked mechanically rather than by fixing the one cell, because the next
   * person to add a row to any tab has no way to know this rule exists.
   */
  test('no spilling view formula overlaps another cell the builder writes', () => {
    interface Box { r0: number; c0: number; r1: number; c1: number; what: string }

    plans.forEach(([title, plan]) => {
      const statics: Box[] = [];
      const spills: Box[] = [];

      plan.values.forEach((v) => {
        const m = /([A-Z]+)(\d+)/.exec(v.range.split(':')[0]!)!;
        const c0 = colIndex(m[1]!);
        const r0 = Number(m[2]!);
        const height = v.rows.length;
        const width = Math.max(...v.rows.map((r) => r.length));
        statics.push({ r0, c0, r1: r0 + height - 1, c1: c0 + width - 1, what: v.range });

        v.rows.forEach((row, ri) => {
          row.forEach((cell, ci) => {
            // Only TOP-LEVEL viewFormula output spills. The calendar nests an
            // ARRAY_CONSTRAIN inside TEXTJOIN, which collapses it to one
            // string — that one occupies a single cell and must not be flagged.
            const s = String(cell);
            if (!s.startsWith('=IFERROR(ARRAY_CONSTRAIN(')) return;
            const dims = /,\s*(\d+),\s*(\d+)\)\s*,\s*"[^"]*"\)$/.exec(s);
            assert.ok(dims, `${title}!${v.range}: cannot read spill size`);
            spills.push({
              r0: r0 + ri, c0: c0 + ci,
              r1: r0 + ri + Number(dims![1]) - 1,
              c1: c0 + ci + Number(dims![2]) - 1,
              what: `${v.range} (${dims![1]}×${dims![2]})`,
            });
          });
        });
      });

      spills.forEach((sp) => {
        statics.forEach((st) => {
          if (st.r0 === sp.r0 && st.c0 === sp.c0) return; // the formula's own cell
          const hits = sp.r0 <= st.r1 && st.r0 <= sp.r1 && sp.c0 <= st.c1 && st.c0 <= sp.c1;
          assert.ok(
            !hits,
            `${title}: spill ${sp.what} covers rows ${sp.r0}-${sp.r1} cols ${sp.c0}-${sp.c1} ` +
            `and would be blocked by ${st.what} at row ${st.r0} col ${st.c0} → #REF!`,
          );
        });
        const size = sizeOf(title);
        assert.ok(sp.r1 <= size.rows, `${title}: spill ${sp.what} needs row ${sp.r1} of ${size.rows}`);
        assert.ok(sp.c1 < size.cols, `${title}: spill ${sp.what} needs col ${sp.c1} of ${size.cols}`);
      });
    });
  });

  test('the activity feed still shows 10 rows and still reads อัปเดตล่าสุด', () => {
    const dash = byTitle.get('📊 ภาพรวม')!;
    const feed = dash.values.find((v) => String(v.rows[0]?.[0]).includes('ยังไม่มีความเคลื่อนไหว'));
    assert.ok(feed, 'the activity feed formula is gone');
    assert.match(String(feed!.rows[0]![0]), /, 10, 4\)/);
    // W = ความคืบหน้า, T = อัปเดตล่าสุด — the columns the header row promises.
    assert.ok(String(feed!.rows[0]![0]).includes(`'_ข้อมูลคำนวณ'!W2:W`));
    assert.ok(String(feed!.rows[0]![0]).includes(`'_ข้อมูลคำนวณ'!T2:T`));
  });

  test('an empty source degrades to copy, not to an error', () => {
    // IFERROR still has a job: FILTER with no matching row returns #N/A.
    const dash = byTitle.get('📊 ภาพรวม')!;
    const feed = dash.values.find((v) => String(v.rows[0]?.[0]).includes('ยังไม่มีความเคลื่อนไหว'))!;
    assert.match(String(feed.rows[0]![0]), /^=IFERROR\(/);
    assert.match(String(feed.rows[0]![0]), /"ยังไม่มีความเคลื่อนไหว"\)$/);
  });

  /** PART C — progress must be the pipeline stage, and must match the dots. */
  describe('ความคืบหน้า is derived from status', () => {
    const calcRow = calcFormulas()[0]!;
    const W = calcRow[22]!;
    const Q = calcRow[16]!;

    test('calc column W reads the STATUS column, not master column L', () => {
      assert.ok(W.includes(`INDIRECT("'งานของฉัน'!H2:H")`), W);
      assert.ok(!W.includes(`INDIRECT("'งานของฉัน'!L2:L")`), 'W still mirrors the old progress column');
    });

    STAGE_PROGRESS.forEach(({ label, percent }) => {
      test(`${label} → ${percent}%`, () => {
        assert.ok(
          W.includes(`="${label}", "${progressBar(percent, 100)}"`),
          `W has no branch for ${label}: ${W}`,
        );
      });
    });

    /**
     * The label in STAGE_PROGRESS is what the calc sheet string-matches on. If
     * it ever drifts from what the sync actually writes into column H, the IFS
     * finds no branch, falls through to "" and the whole column silently reads
     * blank — no error, no log line.
     */
    test('every status the sync can write has a branch, and the labels agree', () => {
      const fromSync = Object.entries(STATUS_LABEL) as [TaskItemStatus, string][];
      assert.equal(STAGE_PROGRESS.length, fromSync.length);
      fromSync.forEach(([status, label]) => {
        const stage = STAGE_PROGRESS.find((s) => s.status === status);
        assert.ok(stage, `STAGE_PROGRESS has no entry for ${status}`);
        assert.equal(stage!.label, label, `${status}: table says "${stage!.label}"`);
        assert.ok(W.includes(`="${label}"`), `no progress branch for ${label}`);
      });
    });

    test('an unknown status falls through to blank, not to #N/A', () => {
      assert.match(W, /TRUE, ""\)/);
    });

    /**
     * The dots and the percentage are two renderings of one fact, so they must
     * not contradict each other — the complaint was a row reading กำลังทำ next
     * to 0%. A stage counts as reached when its dot is filled (●) or active
     * (◐); ✖ marks a stage that was attempted and bounced, so it does NOT
     * count, which is why ตีกลับ sits back at the work stage.
     */
    test('the pipeline dots and the percentage agree on every status', () => {
      STAGE_PROGRESS.forEach(({ label, percent }) => {
        assert.ok(Q.includes(`="${label}"`), `${label} has no pipeline dots`);
        const dots = Q.split(`="${label}", "`)[1]!.split('"')[0]!;
        const reached = (dots.match(/[●◐]/g) ?? []).length;
        assert.equal(
          reached,
          Math.round((percent / 100) * 4),
          `${label}: dots "${dots}" show ${reached} of 4 stages but progress says ${percent}%`,
        );
      });
    });
  });

  /** PART D — a cancelled task must not sit on the calendar looking live. */
  describe('ปฏิทิน excludes closed-but-not-completed rows', () => {
    const cells = byTitle.get('🗓️ ปฏิทิน')!.values
      .flatMap((v) => v.rows.flat())
      .map(String)
      .filter((s) => s.includes('TEXTJOIN'));

    test('every day cell filters out ยกเลิก and ลบแล้ว', () => {
      assert.equal(cells.length, 42, 'expected 6 weeks × 7 days of day cells');
      cells.forEach((f) => {
        assert.ok(f.includes(`'_ข้อมูลคำนวณ'!$F$2:$F<>"ยกเลิก"`), f.slice(0, 160));
        assert.ok(f.includes(`'_ข้อมูลคำนวณ'!$F$2:$F<>"ลบแล้ว"`), f.slice(0, 160));
      });
    });

    test('completed tasks are still shown, marked with ✓', () => {
      // The calendar deliberately differs from the other tabs here: it cannot
      // use calc column N (ยังไม่จบ) because it wants เสร็จแล้ว on the grid.
      cells.forEach((f) => assert.ok(f.includes(`="เสร็จแล้ว", "✓ "`), f.slice(0, 160)));
    });

    test('the exclusion sits in the FILTER, not in the sort or the cap', () => {
      const f = cells[0]!;
      const filterArgs = f.slice(f.indexOf('FILTER('), f.indexOf('), 1, TRUE)'));
      assert.ok(filterArgs.includes('<>"ยกเลิก"'), filterArgs.slice(0, 200));
    });

    test('the legend tells the user cancelled work is hidden', () => {
      assert.ok(allText(byTitle.get('🗓️ ปฏิทิน')!).includes('ไม่แสดงงานที่ยกเลิก'));
    });
  });

  /** PART A — the optional Apps Script add-on is no longer advertised. */
  describe('วิธีสั่งงาน no longer points at the Apps Script add-on', () => {
    const help = byTitle.get('➕ วิธีสั่งงาน')!;
    const text = allText(help);

    test('no add-on section, install steps or file path survive', () => {
      ['สคริปต์เสริม', 'nookeb-addon', 'Apps Script', 'installTriggers', 'google-sheets-workspace']
        .forEach((needle) => assert.ok(!text.includes(needle), `help tab still mentions ${needle}`));
    });

    test('no other tab references the add-on either', () => {
      plans.forEach(([title, plan]) => {
        assert.ok(!allText(plan).includes('nookeb-addon'), `${title} references the add-on`);
      });
    });

    test('the remaining copy still ends on a real instruction, not a blank gap', () => {
      // The section was removed by dropping rows, not by blanking them — the
      // last written row must still carry text or the tab ends in dead space.
      const block = help.values.find((v) => v.rows.length > 5)!;
      const last = block.rows[block.rows.length - 1]!;
      assert.ok(String(last[1] ?? '').trim().length > 0, JSON.stringify(last));
      assert.ok(text.includes('ลบแถวในชีต'), 'the preceding section was removed too');
    });
  });
});

/**
 * PART B + C + D (layout v6) — the performance layer.
 *
 * HOW THESE TESTS WORK, and what they can and cannot prove. The metrics live in
 * spreadsheet formulas, which node cannot evaluate. So each metric is pinned
 * from both ends:
 *   1. a reference implementation below states the RULE, and fixtures exercise
 *      exactly the three properties that are easy to get wrong (a late row must
 *      stay in the on-time denominator; an on-time row must leave the lateness
 *      average entirely rather than weigh 0; workload counts by intake month);
 *   2. string assertions pin the generated formulas to that rule — which calc
 *      column is the numerator and which is the denominator — so a swap in the
 *      sheet fails here even though the sheet itself never runs.
 * Together they catch the realistic regression: someone "simplifies" the
 * lateness average to divide by the completed count and turns "when someone is
 * late, how late" into a much smaller, much less useful number.
 */
describe('layout v6 — performance metrics', () => {
  const TITLES = [
    '_ตัวเลือก', '_ข้อมูลคำนวณ', '📊 ภาพรวม', '⚡ ความสำคัญ', '🔄 ติดตามสถานะ',
    '👥 รายงานทีม', '🗓️ ปฏิทิน', '📈 วิเคราะห์', '📅 สรุปงาน', '✅ งานเสร็จ',
    '📊 รายงานผลการทำงานรายบุคคล', '➕ วิธีสั่งงาน',
  ];
  const gid = (t: string) => {
    const i = TITLES.indexOf(t);
    if (i === -1) throw new Error(`unknown tab ${t}`);
    return 100 + i;
  };
  const plans = composeWorkspacePlans(gid, 0);
  const byTitle = new Map<string, TabPlan>(plans);
  const PERF = '📊 รายงานผลการทำงานรายบุคคล';
  const NAV_TAB_TITLES = TITLES.filter((t) => !t.startsWith('_'));
  const allText = (plan: TabPlan) =>
    plan.values.flatMap((v) => v.rows.flat()).map(String).join('\n');
  const calcRow = calcFormulas()[0]!;

  /** 0-based column index → sheet letter, for checking CALC_PERF. */
  const letter = (index: number): string => {
    let n = index;
    let out = '';
    do {
      out = String.fromCharCode(65 + (n % 26)) + out;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return out;
  };

  // ---- the rule, stated once ------------------------------------------
  interface Row {
    who: string[];
    /** Sheets serial-ish day numbers; null while the row is still open. */
    doneAt: number | null;
    deadline: number | null;
    /** Month the work was handed over, as "YYYY-MM". */
    intakeMonth: string;
    /** Hours to รับทราบ; null when nobody has acknowledged. */
    ackHours: number | null;
  }
  /** The seven per-row primitives calc columns X–AD carry, in TypeScript. */
  const perfRow = (r: Row) => {
    const measurable = r.doneAt !== null && r.deadline !== null;
    const late = measurable && r.doneAt! > r.deadline!;
    return {
      onTime: measurable && r.doneAt! <= r.deadline! ? 1 : 0, // X
      measurable: measurable ? 1 : 0, // Y
      lateDays: late ? r.doneAt! - r.deadline! : 0, // Z
      lateCount: late ? 1 : 0, // AA
      intakeMonth: r.intakeMonth, // AB
      ackHours: r.ackHours ?? 0, // AC
      ackCount: r.ackHours === null ? 0 : 1, // AD
    };
  };
  /** The SUMPRODUCT(match × column) shape every per-person cell uses. */
  const sum = (rows: Row[], who: string, pick: (p: ReturnType<typeof perfRow>) => number) =>
    rows.filter((r) => r.who.includes(who)).reduce((n, r) => n + pick(perfRow(r)), 0);
  /** A ratio cell: blank (not 0) when the denominator is empty. */
  const ratio = (
    rows: Row[], who: string,
    num: (p: ReturnType<typeof perfRow>) => number,
    den: (p: ReturnType<typeof perfRow>) => number,
  ): number | '' => {
    const d = sum(rows, who, den);
    return d === 0 ? '' : sum(rows, who, num) / d;
  };

  describe('on-time rate — late work counts against you, unmeasurable work does not', () => {
    const rows: Row[] = [
      { who: ['สมชาย'], doneAt: 10, deadline: 12, intakeMonth: '2026-08', ackHours: 1 }, // early
      { who: ['สมชาย'], doneAt: 20, deadline: 15, intakeMonth: '2026-08', ackHours: 2 }, // LATE
      { who: ['สมหญิง'], doneAt: 12, deadline: 12, intakeMonth: '2026-08', ackHours: null }, // exactly on time
    ];

    test('a late row is excluded from the numerator but kept in the denominator', () => {
      assert.equal(sum(rows, 'สมชาย', (p) => p.onTime), 1);
      assert.equal(sum(rows, 'สมชาย', (p) => p.measurable), 2);
      assert.equal(ratio(rows, 'สมชาย', (p) => p.onTime, (p) => p.measurable), 0.5);
    });

    test('finishing exactly on the deadline counts as on time, not late', () => {
      assert.equal(ratio(rows, 'สมหญิง', (p) => p.onTime, (p) => p.measurable), 1);
    });

    test('a finished task with NO deadline is in neither half', () => {
      const noDeadline: Row[] = [
        ...rows,
        { who: ['สมชาย'], doneAt: 30, deadline: null, intakeMonth: '2026-08', ackHours: null },
      ];
      // It cannot be on time or late, so it must not dilute the rate either way.
      assert.equal(ratio(noDeadline, 'สมชาย', (p) => p.onTime, (p) => p.measurable), 0.5);
    });

    test('an unfinished task does not count as a miss while it is still open', () => {
      const open: Row[] = [
        ...rows,
        { who: ['สมชาย'], doneAt: null, deadline: 5, intakeMonth: '2026-08', ackHours: null },
      ];
      assert.equal(ratio(open, 'สมชาย', (p) => p.onTime, (p) => p.measurable), 0.5);
    });

    test('nothing measurable reads BLANK, never 0% — "no evidence" is not "bad"', () => {
      const rookie: Row[] = [
        { who: ['น้องใหม่'], doneAt: null, deadline: 9, intakeMonth: '2026-08', ackHours: null },
      ];
      assert.equal(ratio(rookie, 'น้องใหม่', (p) => p.onTime, (p) => p.measurable), '');
    });
  });

  describe('lateness average — on-time work is excluded, not averaged in as 0', () => {
    const rows: Row[] = [
      { who: ['สมชาย'], doneAt: 24, deadline: 20, intakeMonth: '2026-08', ackHours: 1 }, // 4 days late
      { who: ['สมชาย'], doneAt: 10, deadline: 12, intakeMonth: '2026-08', ackHours: 1 }, // early
      { who: ['สมชาย'], doneAt: 15, deadline: 15, intakeMonth: '2026-08', ackHours: 1 }, // on time
    ];

    test('answers "when late, how late" — 4 days, not 4 spread over three tasks', () => {
      const avg = ratio(rows, 'สมชาย', (p) => p.lateDays, (p) => p.lateCount);
      assert.equal(avg, 4);
      // The regression this exists for: dividing by the completed count instead
      // of the late count silently turns 4 days into 1.3.
      assert.notEqual(avg, sum(rows, 'สมชาย', (p) => p.lateDays) / 3);
    });

    test('the denominator counts late rows only, so on-time rows are truly absent', () => {
      assert.equal(sum(rows, 'สมชาย', (p) => p.lateCount), 1);
      assert.equal(sum(rows, 'สมชาย', (p) => p.measurable), 3);
    });

    test('never late reads BLANK, not 0 — 0 would look like "always exactly on the deadline"', () => {
      const punctual = rows.filter((r) => r.doneAt! <= r.deadline!);
      assert.equal(ratio(punctual, 'สมชาย', (p) => p.lateDays, (p) => p.lateCount), '');
    });
  });

  describe('workload — counted per person per intake month', () => {
    const rows: Row[] = [
      { who: ['สมชาย'], doneAt: null, deadline: null, intakeMonth: '2026-08', ackHours: null },
      { who: ['สมชาย'], doneAt: 5, deadline: 6, intakeMonth: '2026-08', ackHours: 1 },
      { who: ['สมชาย'], doneAt: 5, deadline: 6, intakeMonth: '2026-07', ackHours: 1 },
      { who: ['สมหญิง'], doneAt: null, deadline: null, intakeMonth: '2026-08', ackHours: null },
      // One row, two assignees — it lands on BOTH people's desks.
      { who: ['สมชาย', 'สมหญิง'], doneAt: null, deadline: null, intakeMonth: '2026-08', ackHours: null },
    ];
    const load = (who: string, month: string) =>
      sum(rows, who, (p) => (p.intakeMonth === month ? 1 : 0));

    test('hand-checked counts per person per month', () => {
      assert.equal(load('สมชาย', '2026-08'), 3);
      assert.equal(load('สมชาย', '2026-07'), 1);
      assert.equal(load('สมหญิง', '2026-08'), 2);
      assert.equal(load('สมหญิง', '2026-07'), 0);
    });

    test('workload counts everything received, finished or not', () => {
      // The point of the column: someone with 3× the intake and a slightly
      // lower on-time rate may be outperforming a lighter load, which only
      // works if the count is intake and not completions.
      assert.equal(load('สมชาย', '2026-08'), 3);
      assert.equal(sum(rows, 'สมชาย', (p) => p.measurable), 2);
    });
  });

  // ---- the formulas are pinned to that rule ----------------------------
  describe('_ข้อมูลคำนวณ X–AD carry those primitives', () => {
    test('CALC_PERF names the column each primitive really lands in', () => {
      const expected: [string, string][] = [
        [CALC_PERF.ON_TIME, letter(23)],
        [CALC_PERF.MEASURABLE, letter(24)],
        [CALC_PERF.LATE_DAYS, letter(25)],
        [CALC_PERF.LATE_COUNT, letter(26)],
        [CALC_PERF.INTAKE_MONTH, letter(27)],
        [CALC_PERF.ACK_HOURS, letter(28)],
        [CALC_PERF.ACK_COUNT, letter(29)],
      ];
      expected.forEach(([named, actual]) => assert.equal(named, actual));
      assert.equal(calcRow.length, 30);
    });

    const Q = `INDIRECT("'งานของฉัน'!Q2:Q")`; // เสร็จเมื่อ
    const R = `INDIRECT("'งานของฉัน'!R2:R")`; // กำหนดส่ง
    const S = `INDIRECT("'งานของฉัน'!S2:S")`; // เวลาตอบรับ

    test('X is on time (<=), AA is late (>) — the same pair, opposite sides', () => {
      assert.ok(calcRow[23]!.includes(`${Q}<=${R}`), calcRow[23]);
      assert.ok(calcRow[26]!.includes(`${Q}>${R}`), calcRow[26]);
    });

    test('Y is the denominator: finished AND had a deadline, nothing about timing', () => {
      assert.ok(calcRow[24]!.includes(`(${Q}<>"")*(${R}<>"")`), calcRow[24]);
      assert.ok(!calcRow[24]!.includes('<='), 'Y must not judge timeliness');
      assert.ok(!calcRow[24]!.includes(`${Q}>${R}`), 'Y must not judge timeliness');
    });

    test('Z is 0 for anything not late, so it is only ever averaged over AA', () => {
      assert.ok(calcRow[25]!.includes(`${Q}>${R}`), calcRow[25]);
      assert.match(calcRow[25]!, /, 0\)\)\)$/); // the else branch, closing IF/IF/ARRAYFORMULA
    });

    test('every subtraction goes through N(), so a blank stamp cannot poison the column', () => {
      assert.ok(calcRow[25]!.includes(`N(${Q})-N(${R})`), calcRow[25]);
      assert.ok(calcRow[28]!.includes(`N(${S})`), calcRow[28]);
    });

    test('AD counts acknowledgements with ISNUMBER, not ">0"', () => {
      // A genuine 20-second รับทราบ rounds to 0.01 and a faster one to 0.00; a
      // ">0" gate would throw away exactly the most responsive rows.
      assert.ok(calcRow[29]!.includes(`ISNUMBER(${S})`), calcRow[29]);
      assert.ok(!calcRow[29]!.includes('>0'), calcRow[29]);
    });

    test('AB buckets by สร้างเมื่อ (intake), not by the deadline', () => {
      const P = `INDIRECT("'งานของฉัน'!P2:P")`;
      assert.ok(calcRow[27]!.includes(`YEAR(N(${P}))`), calcRow[27]);
      assert.ok(!calcRow[27]!.includes('R2:R'), 'AB must not read the deadline column');
    });

    test('the new columns still reach the master only through INDIRECT', () => {
      calcRow.slice(23).forEach((f) => {
        assert.ok(!/(^|[^"])'งานของฉัน'!/.test(f), f);
      });
    });
  });

  describe('รายงานทีม — "finished" and "finished on time" are separate columns', () => {
    const team = byTitle.get('👥 รายงานทีม')!;
    const header = team.values.find((v) => v.range === 'A5')!.rows[0]! as string[];

    test('both percent columns exist and are named so they cannot be confused', () => {
      assert.ok(header.includes('% เสร็จทั้งหมด'), header.join(' | '));
      assert.ok(header.includes('% เสร็จตรงกำหนด'), header.join(' | '));
      assert.ok(!header.includes('% สำเร็จ'), 'the ambiguous old label survives');
    });

    test('the existing completion column is untouched — still เสร็จแล้ว ÷ ได้รับทั้งหมด', () => {
      const i = team.values.find((v) => v.range === 'I6')!.rows[0]![0] as string;
      assert.ok(i.includes('$G$6:$G/$B$6:$B'), i);
    });

    test('the new column uses the on-time pair, not the completion count', () => {
      const j = team.values.find((v) => v.range === 'J6')!.rows[0]![0] as string;
      assert.ok(j.includes(`$${CALC_PERF.ON_TIME}$2:$${CALC_PERF.ON_TIME}$2000`), j);
      assert.ok(j.includes(`$${CALC_PERF.MEASURABLE}$2:$${CALC_PERF.MEASURABLE}$2000`), j);
      assert.ok(j.includes('IFERROR('), 'no measurable work must read blank, not 0%');
    });

    test('the caveat row explains the difference where the reader will see it', () => {
      const text = allText(team);
      assert.ok(text.includes('ไม่สนกำหนดส่ง'), text.slice(0, 400));
      assert.ok(text.includes('เสร็จทันกี่ %'), text.slice(0, 400));
    });
  });

  /**
   * The alignment bug this pins: shiftPlan moves a value's RANGE for the nav
   * strip but never the formula TEXT, so an ARRAYFORMULA that reads its own
   * tab must be written through self(). รายงานทีม's % and ภาระงานค้าง columns
   * were not, and read from one row above their own output — the first cell
   * landed on the header row and every person's numbers sat one row off.
   */
  test('an ARRAYFORMULA over its own tab starts on the row it is written to', () => {
    plans.forEach(([title, plan]) => {
      if (!NAV_TAB_TITLES.includes(title)) return;
      plan.values.forEach((v) => {
        v.rows.forEach((row) => {
          row.forEach((cell) => {
            const s = String(cell);
            if (!s.startsWith('=ARRAYFORMULA(')) return;
            const own = s.replace(/'[^']*'!\$?[A-Z]{1,2}\$?\d+(:\$?[A-Z]{1,2}\$?\d*)?/g, '');
            const rows = [...own.matchAll(/\$?[A-Z]{1,2}\$?(\d+)/g)].map((m) => Number(m[1]));
            if (rows.length === 0) return;
            const at = Number(/([A-Z]+)(\d+)/.exec(v.range)![2]);
            assert.equal(
              Math.min(...rows), at,
              `${title}!${v.range}: reads from row ${Math.min(...rows)} but spills from ${at} — needs self()`,
            );
          });
        });
      });
    });
  });

  describe('📊 รายงานผลการทำงานรายบุคคล', () => {
    const perf = byTitle.get(PERF)!;
    const text = allText(perf);
    const table = perf.values.find((v) => v.range === 'A6')!.rows[0]![0] as string;

    test('the tab is generated and reachable from the nav on every visible tab', () => {
      assert.ok(perf, 'the tab was not built');
      NAV_TAB_TITLES.forEach((t) => {
        const nav = byTitle.get(t)!.values[0]!.rows[0]!.map(String).join(' ');
        assert.ok(nav.includes(`#gid=${gid(PERF)}`), `${t} nav has no link to the report`);
      });
    });

    test('one row per person, with exactly the columns the report promises', () => {
      const header = perf.values.find((v) => v.range === 'A5')!.rows[0]!;
      assert.deepEqual(header, [
        'ชื่อ', 'งานทั้งหมด', 'เสร็จแล้ว', 'เสร็จทันกำหนด %',
        'ค่าเฉลี่ยล่าช้า (วัน, เมื่อล่าช้า)', 'เวลาตอบรับเฉลี่ย (ชม.)',
        'ภาระงานเดือนนี้', 'ภาระงานเดือนก่อน',
      ]);
    });

    test('names come from the existing roster, not from a second extraction', () => {
      assert.ok(table.includes(`'_ตัวเลือก'!$A$2:$A$40`), table.slice(0, 200));
    });

    test('default sort is งานทั้งหมด (column 2) descending', () => {
      assert.ok(table.includes('), 2, FALSE)'), table.slice(-260));
    });

    test('each metric reads its own numerator/denominator pair', () => {
      const pair = (n: string, d: string) =>
        table.includes(`$${n}$2:$${n}$2000`) && table.includes(`$${d}$2:$${d}$2000`);
      assert.ok(pair(CALC_PERF.ON_TIME, CALC_PERF.MEASURABLE), 'on-time pair missing');
      assert.ok(pair(CALC_PERF.LATE_DAYS, CALC_PERF.LATE_COUNT), 'lateness pair missing');
      assert.ok(pair(CALC_PERF.ACK_HOURS, CALC_PERF.ACK_COUNT), 'acknowledgement pair missing');
    });

    test('lateness is averaged over the LATE count, never over the completed count', () => {
      const late = `SUMPRODUCT(ISNUMBER(SEARCH(p, '_ข้อมูลคำนวณ'!$E$2:$E$2000)) * '_ข้อมูลคำนวณ'!$${CALC_PERF.LATE_DAYS}$2:$${CALC_PERF.LATE_DAYS}$2000) / ` +
        `SUMPRODUCT(ISNUMBER(SEARCH(p, '_ข้อมูลคำนวณ'!$E$2:$E$2000)) * '_ข้อมูลคำนวณ'!$${CALC_PERF.LATE_COUNT}$2:$${CALC_PERF.LATE_COUNT}$2000)`;
      assert.ok(table.includes(late), 'the lateness average does not divide by นับล่าช้า');
    });

    test('workload compares this month against the previous one, by intake', () => {
      assert.ok(table.includes('DATE(YEAR(TODAY()), MONTH(TODAY())+0, 1)'), table.slice(0, 400));
      assert.ok(table.includes('DATE(YEAR(TODAY()), MONTH(TODAY())-1, 1)'), table.slice(0, 400));
      assert.ok(table.includes(`$${CALC_PERF.INTAKE_MONTH}$2:$${CALC_PERF.INTAKE_MONTH}$2000`));
    });

    test('every ratio degrades to blank, so nobody is scored on missing data', () => {
      assert.equal((table.match(/IFERROR\(/g) ?? []).length >= 4, true, table.slice(0, 120));
      assert.ok(table.includes('"ยังไม่มีข้อมูล"'));
    });

    test('the below-threshold highlight is mild and skips people with no data', () => {
      const rules = perf.requests
        .filter((r) => r.addConditionalFormatRule?.rule?.booleanRule?.condition?.type === 'CUSTOM_FORMULA')
        .map((r) => r.addConditionalFormatRule!.rule!);
      assert.equal(rules.length, 1);
      const f = rules[0]!.booleanRule!.condition!.values![0]!.userEnteredValue!;
      assert.ok(f.includes('<>""'), `a blank would test as 0 and flag every newcomer: ${f}`);
      assert.ok(f.includes('<0.7'), f);
      // Palette check: the coaching tint, not the DANGER red used for overdue.
      const bg = rules[0]!.booleanRule!.format!.backgroundColor!;
      assert.ok(Math.round(bg.red! * 255) === 255 && Math.round(bg.green! * 255) === 243, JSON.stringify(bg));
    });

    /** PART D — the caveats must live in the tab, not only in a chat report. */
    test('row 2 carries the rejection-history caveat, verbatim and unmissable', () => {
      const row2 = perf.values.find((v) => v.range === 'A3')!.rows[0]![0] as string;
      assert.ok(
        row2.includes('ข้อมูลอ้างอิงจากสถานะปัจจุบันของงาน ไม่รวมประวัติงานที่เคยถูกตีกลับก่อนหน้า'),
        row2,
      );
      const merged = perf.requests.filter((r) => r.mergeCells?.range?.startRowIndex === 2);
      assert.ok(merged.length > 0, 'the caveat is not laid out as a full-width banner');
    });

    test('a blank cell is explained as "not measurable", not left to be read as zero', () => {
      assert.ok(text.includes('ช่องว่าง = ยังไม่มีข้อมูลมากพอจะวัด ไม่ได้แปลว่า 0'), text.slice(0, 600));
    });

    test('no urgency-derived metric appears anywhere on the tab', () => {
      // urgency is only populated by the LIFF/dashboard create flows; a task
      // created from a LINE command has none, so splitting performance by it
      // would rank people by which door their work came through.
      ['ความเร่งด่วน', 'อันดับด่วน', 'ด่วนมาก', 'ไม่รีบ'].forEach((needle) => {
        assert.ok(!text.includes(needle), `the report surfaces urgency: ${needle}`);
      });
      [`$J$2:$J`, `$K$2:$K`].forEach((ref) => {
        assert.ok(!table.includes(`'_ข้อมูลคำนวณ'!${ref}`), `the table reads urgency calc column ${ref}`);
      });
    });

    test('no rejection tally is presented as a metric', () => {
      // The word may appear ONLY in the caveat explaining why there is no count.
      const header = perf.values.find((v) => v.range === 'A5')!.rows[0]!.map(String);
      assert.ok(!header.some((h) => h.includes('ตีกลับ')), header.join(' | '));
      assert.ok(!table.includes('ตีกลับ'), 'a rejection count leaked into the table');
    });
  });

  describe('the performance chart', () => {
    const charts = composeChartRequests(gid).filter(
      (r) => r.addChart?.chart?.position?.overlayPosition?.anchorCell?.sheetId === gid(PERF),
    );

    test('exactly one chart, comparing on-time % across people', () => {
      assert.equal(charts.length, 1);
      const spec = charts[0]!.addChart!.chart!.spec!;
      assert.equal(spec.basicChart!.chartType, 'BAR');
      assert.ok(String(spec.title).includes('เสร็จทันกำหนด %'), String(spec.title));
    });

    test('it is fed by the ranked block, which sorts on-time % descending', () => {
      const perf = byTitle.get(PERF)!;
      const rank = perf.values.find((v) => v.range === 'J6')!.rows[0]![0] as string;
      assert.ok(rank.includes(', 2, FALSE)'), rank.slice(-200));
      // It re-sorts the table's OWN output rather than recomputing everything.
      assert.ok(rank.includes('$D$6:$D$44'), rank.slice(0, 200));
      assert.ok(!rank.includes('SUMPRODUCT'), 'the ranking recomputes instead of reusing the table');
    });

    test('its sources are shifted with the nav, so the last person is not dropped', () => {
      const found: number[] = [];
      const walk = (n: unknown): void => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (n && typeof n === 'object') {
          const o = n as Record<string, unknown>;
          if (o.sheetId === gid(PERF) && typeof o.startRowIndex === 'number') {
            found.push(o.startRowIndex);
          }
          Object.values(o).forEach(walk);
        }
      };
      walk(charts[0]!.addChart!.chart!.spec);
      assert.ok(found.length > 0);
      // Header row is nav-free row 4 (0-based 3) → 4 after the shift.
      found.forEach((r) => assert.equal(r, 4));
    });
  });
});

describe('historical-sync stamp', () => {
  test('round-trips through its serialized form', () => {
    const stamp = { at: '2026-08-05T02:00:00.000Z', count: 42 };
    assert.deepEqual(parseHistoricalStamp(serializeHistoricalStamp(stamp)), stamp);
  });

  test('unparseable or absent metadata reads as "never run"', () => {
    // The caller treats null as "backfill has not happened", which triggers an
    // import. Anything ambiguous must therefore fail CLOSED to null only when
    // it really is unusable — a garbage count still counts as a run.
    assert.equal(parseHistoricalStamp(null), null);
    assert.equal(parseHistoricalStamp(''), null);
    assert.equal(parseHistoricalStamp('ไม่ใช่วันที่|3'), null);
    assert.deepEqual(parseHistoricalStamp('2026-08-05T02:00:00.000Z|nope'), {
      at: '2026-08-05T02:00:00.000Z',
      count: 0,
    });
  });

  test('formats the Bangkok clock reading, not UTC', () => {
    assert.equal(
      formatHistoricalStamp({ at: '2026-08-05T02:00:00.000Z', count: 7 }),
      'ดึงล่าสุด 05/08/2026 09:00 · 7 งาน',
    );
  });
});

describe('historical-sync block on the dashboard', () => {
  const TITLES = [
    '_ตัวเลือก', '_ข้อมูลคำนวณ', '📊 ภาพรวม', '⚡ ความสำคัญ', '🔄 ติดตามสถานะ',
    '👥 รายงานทีม', '🗓️ ปฏิทิน', '📈 วิเคราะห์', '📅 สรุปงาน', '✅ งานเสร็จ',
    '📊 รายงานผลการทำงานรายบุคคล', '➕ วิธีสั่งงาน',
  ];
  const build = (syncUrl?: string) =>
    new Map(composeWorkspacePlans((t) => 100 + TITLES.indexOf(t), 0, { syncUrl }));

  /**
   * HISTORICAL_STAMP_A1 is where writeHistoricalStamp reports the result, and
   * it is derived from the block's nav-FREE row while the plan is shifted by the
   * nav. Get that offset wrong and the count silently lands on some other cell —
   * the one failure mode nobody would notice from the code alone.
   */
  test('the exported stamp cell is the cell the builder writes the placeholder into', () => {
    const dash = build().get(DASH_TAB)!;
    const placeholder = dash.values.find((v) => v.range === HISTORICAL_STAMP_A1);
    assert.ok(placeholder, `nothing is written at ${HISTORICAL_STAMP_A1}`);
    assert.match(String(placeholder!.rows[0]![0]), /ยังไม่เคย/);
  });

  test('the button is a hyperlink when a URL is supplied and inert text when not', () => {
    const withUrl = build('https://example.test/dashboard/settings?sync=historical').get(DASH_TAB)!;
    const linked = withUrl.values.find((v) => String(v.rows[0]?.[0]).includes('sync ประวัติงาน'));
    assert.match(String(linked!.rows[0]![0]), /^=HYPERLINK\("https:\/\/example\.test/);

    // No WEB_URL configured must not emit `=HYPERLINK("undefined"…)`.
    const plain = build().get(DASH_TAB)!;
    const label = plain.values.find((v) => String(v.rows[0]?.[0]).includes('sync ประวัติงาน'));
    assert.equal(String(label!.rows[0]![0]).startsWith('='), false);
  });
});
