import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { appendStatusLog, progressBar, toSheetSerial } from './sheets-workspace.service';

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
