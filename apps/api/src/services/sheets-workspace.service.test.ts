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
  DASH_TAB,
  HISTORICAL_STAMP_A1,
  type TabPlan,
} from './sheets-workspace.service';

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
    assert.equal(row.length, 23); // A–W, see CALC_HEADERS
  });

  test('each formula is a spilling ARRAYFORMULA', () => {
    row.forEach((f) => assert.ok(f.startsWith('=ARRAYFORMULA(IF(INDIRECT('), f));
  });
});

describe('composeWorkspacePlans — the nav offset', () => {
  // Deterministic fake gids: the tab's position in the list.
  const TITLES = [
    '_ตัวเลือก', '_ข้อมูลคำนวณ', '📊 ภาพรวม', '⚡ ความสำคัญ', '🔄 ติดตามสถานะ',
    '👥 รายงานทีม', '🗓️ ปฏิทิน', '📈 วิเคราะห์', '📅 สรุปงาน', '✅ งานเสร็จ', '➕ วิธีสั่งงาน',
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
    '🗓️ ปฏิทิน', '📈 วิเคราะห์', '📅 สรุปงาน', '✅ งานเสร็จ', '➕ วิธีสั่งงาน',
  ];

  const firstRow = (a1: string) => Number(/([A-Z]+)(\d+)/.exec(a1)![2]);

  test('every visible tab writes a nav strip into row 1', () => {
    NAV_TABS.forEach((t) => {
      const nav = byTitle.get(t)!.values[0]!;
      assert.equal(firstRow(nav.range), 1, t);
      assert.equal(nav.rows[0]!.length, 8, t);
    });
  });

  test('nav links point at the gid of the tab they name', () => {
    const nav = byTitle.get('📊 ภาพรวม')!.values[0]!.rows[0]! as string[];
    assert.ok(nav[0]!.includes(`#gid=${gid('📊 ภาพรวม')}`), nav[0]);
    assert.ok(nav[1]!.includes(`#gid=${gid('⚡ ความสำคัญ')}`), nav[1]);
    // The last link goes to the master tab, whose gid is passed separately.
    assert.ok(nav[7]!.includes('#gid=0'), nav[7]);
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
    '👥 รายงานทีม', '🗓️ ปฏิทิน', '📈 วิเคราะห์', '📅 สรุปงาน', '✅ งานเสร็จ', '➕ วิธีสั่งงาน',
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
    '👥 รายงานทีม', '🗓️ ปฏิทิน', '📈 วิเคราะห์', '📅 สรุปงาน', '✅ งานเสร็จ', '➕ วิธีสั่งงาน',
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
    '👥 รายงานทีม', '🗓️ ปฏิทิน', '📈 วิเคราะห์', '📅 สรุปงาน', '✅ งานเสร็จ', '➕ วิธีสั่งงาน',
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
    '👥 รายงานทีม', '🗓️ ปฏิทิน', '📈 วิเคราะห์', '📅 สรุปงาน', '✅ งานเสร็จ', '➕ วิธีสั่งงาน',
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
