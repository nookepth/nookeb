import { strict as assert } from 'node:assert';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { exportFilename, exportTasksToExcel, type TaskExportRow } from './export.service';

/**
 * Unit tests for the ระบบตามงาน .xlsx export. The service is pure, so the whole
 * workbook can be round-tripped through exceljs and asserted on — no DB, no R2.
 */

function row(over: Partial<TaskExportRow> = {}): TaskExportRow {
  return {
    title: 'สรุปยอดประจำเดือน',
    description: 'รวมยอดทุกสาขา',
    type: 'single',
    deadline: '2026-08-05T02:00:00.000Z', // 09:00 Bangkok
    createdBy: 'พี่หนู',
    assignees: ['เอ', 'บี'],
    status: 'pending',
    createdAt: '2026-07-22T03:00:00.000Z',
    updatedAt: null,
    ...over,
  };
}

async function readBack(rows: TaskExportRow[]): Promise<ExcelJS.Worksheet> {
  const buffer = await exportTasksToExcel(rows);
  const wb = new ExcelJS.Workbook();
  // exceljs declares its own `Buffer` alias that a Node Buffer isn't assignable
  // to structurally — load() reads the bytes fine either way.
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = wb.getWorksheet('งานของฉัน');
  assert.ok(sheet, 'worksheet "งานของฉัน" is missing');
  return sheet;
}

test('header row carries the Thai column names, brand fill and white bold text', async () => {
  const sheet = await readBack([row()]);
  const header = sheet.getRow(1);

  assert.equal(header.getCell(1).value, 'ลำดับ');
  assert.equal(header.getCell(2).value, 'ชื่องาน');
  assert.equal(header.getCell(8).value, 'สถานะ');
  assert.equal(header.getCell(10).value, 'อัปเดตล่าสุด');

  const fill = header.getCell(1).fill as ExcelJS.FillPattern;
  assert.equal(fill.fgColor?.argb, 'FFB91C1C');
  assert.equal(header.font?.bold, true);
  assert.equal(header.font?.color?.argb, 'FFFFFFFF');
});

test('freeze pane on row 1 + auto-filter across every column', async () => {
  const sheet = await readBack([row(), row()]);
  // A round-tripped view carries every Excel default (zoom, gridlines, …), so
  // assert only the two properties this export actually sets.
  assert.equal(sheet.views[0]?.state, 'frozen');
  assert.equal((sheet.views[0] as { ySplit?: number }).ySplit, 1);

  // The object form we set is written out and read back as a range string —
  // A1:J3 = all 10 columns over the header + 2 data rows.
  assert.equal(sheet.autoFilter, 'A1:J3');
});

/** Unfilled cells come back as pattern 'none' rather than undefined. */
function fillColor(cell: ExcelJS.Cell): string | undefined {
  const fill = cell.fill as ExcelJS.FillPattern | undefined;
  if (!fill || fill.pattern === 'none') return undefined;
  return fill.fgColor?.argb;
}

test('zebra: first data row white, second shaded', async () => {
  const sheet = await readBack([row(), row(), row()]);
  assert.equal(fillColor(sheet.getRow(2).getCell(2)), undefined);
  assert.equal(fillColor(sheet.getRow(3).getCell(2)), 'FFF9FAFB');
  assert.equal(fillColor(sheet.getRow(4).getCell(2)), undefined);
});

test('statuses and types render in Thai — including the review loop', async () => {
  const sheet = await readBack([
    row({ status: 'submitted', type: 'multi' }),
    row({ status: 'rejected', type: 'recurring' }),
    row({ status: 'done' }),
  ]);
  assert.equal(sheet.getRow(2).getCell(8).value, 'รอตรวจ');
  assert.equal(sheet.getRow(2).getCell(4).value, 'หลายรายการ');
  assert.equal(sheet.getRow(3).getCell(8).value, 'ตีกลับ');
  assert.equal(sheet.getRow(3).getCell(4).value, 'งานประจำ');
  assert.equal(sheet.getRow(4).getCell(8).value, 'เสร็จแล้ว');
});

test('dates land as real date cells showing Bangkok wall clock, not UTC', async () => {
  const sheet = await readBack([row()]);
  const cell = sheet.getRow(2).getCell(5);
  const value = cell.value as Date;
  assert.ok(value instanceof Date, 'deadline should be a date cell, not a string');
  // 02:00Z is 09:00 in Bangkok — that is what the reader must see.
  assert.equal(value.getUTCHours(), 9);
  assert.equal(value.getUTCDate(), 5);
  assert.equal(cell.numFmt, 'dd/mm/yyyy hh:mm');
});

test('missing deadline / updatedAt leave the cell empty rather than 1970', async () => {
  const sheet = await readBack([row({ deadline: null, updatedAt: null })]);
  assert.equal(sheet.getRow(2).getCell(5).value, null);
  assert.equal(sheet.getRow(2).getCell(10).value, null);
});

test('assignees are joined; row numbering starts at 1', async () => {
  const sheet = await readBack([row({ assignees: ['เอ', 'บี', 'ซี'] }), row({ assignees: [] })]);
  assert.equal(sheet.getRow(2).getCell(1).value, 1);
  assert.equal(sheet.getRow(2).getCell(7).value, 'เอ, บี, ซี');
  assert.equal(sheet.getRow(3).getCell(1).value, 2);
  // No assignees → an empty string cell (exceljs round-trips '' as '', not null)
  assert.equal(sheet.getRow(3).getCell(7).value, '');
});

test('an empty export still produces a valid, filterable header-only sheet', async () => {
  const sheet = await readBack([]);
  assert.equal(sheet.rowCount, 1);
  assert.equal(sheet.getRow(1).getCell(1).value, 'ลำดับ');
  assert.equal(sheet.getRow(1).getCell(10).value, 'อัปเดตล่าสุด');
  // Guards the Math.max(1, rowCount) clamp — without it the range would be A1:J0.
  assert.equal(sheet.autoFilter, 'A1:J1');
});

test('exportFilename uses the Bangkok calendar day', () => {
  // 2026-07-22T18:30Z is already 2026-07-23 in Bangkok.
  assert.equal(exportFilename(new Date('2026-07-22T18:30:00.000Z')), 'nookeb-tasks-20260723.xlsx');
  assert.equal(exportFilename(new Date('2026-07-22T02:00:00.000Z')), 'nookeb-tasks-20260722.xlsx');
});
