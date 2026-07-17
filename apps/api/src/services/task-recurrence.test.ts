import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNextOccurrence } from './task-recurrence';

// All expectations are UTC instants; Bangkok = UTC+7 (no DST).
// 2026-07-18T02:00:00Z == 2026-07-18 09:00 Bangkok.

test('daily: today at the given time when still ahead', () => {
  const next = computeNextOccurrence(
    { freq: 'daily', time: '09:00' },
    new Date('2026-07-18T00:00:00Z'), // 07:00 Bangkok
  );
  assert.equal(next.toISOString(), '2026-07-18T02:00:00.000Z');
});

test('daily: rolls to tomorrow once the time has passed', () => {
  const next = computeNextOccurrence(
    { freq: 'daily', time: '09:00' },
    new Date('2026-07-18T02:00:00Z'), // exactly 09:00 Bangkok — strictly after
  );
  assert.equal(next.toISOString(), '2026-07-19T02:00:00.000Z');
});

test('weekly: next Monday 10:30 Bangkok', () => {
  // 2026-07-18 is a Saturday; next Monday is 2026-07-20.
  const next = computeNextOccurrence(
    { freq: 'weekly', weekday: 1, time: '10:30' },
    new Date('2026-07-18T00:00:00Z'),
  );
  assert.equal(next.toISOString(), '2026-07-20T03:30:00.000Z');
});

test('weekly: same weekday later today counts', () => {
  // 2026-07-18 is a Saturday (weekday 6); 23:00 Bangkok is still ahead.
  const next = computeNextOccurrence(
    { freq: 'weekly', weekday: 6, time: '23:00' },
    new Date('2026-07-18T00:00:00Z'),
  );
  assert.equal(next.toISOString(), '2026-07-18T16:00:00.000Z');
});

test('monthly: this month when the day is still ahead', () => {
  const next = computeNextOccurrence(
    { freq: 'monthly', day: 25, time: '09:00' },
    new Date('2026-07-18T00:00:00Z'),
  );
  assert.equal(next.toISOString(), '2026-07-25T02:00:00.000Z');
});

test('monthly: rolls to next month when the day already passed', () => {
  const next = computeNextOccurrence(
    { freq: 'monthly', day: 5, time: '09:00' },
    new Date('2026-07-18T00:00:00Z'),
  );
  assert.equal(next.toISOString(), '2026-08-05T02:00:00.000Z');
});

test('monthly: day 31 clamps to the last day of a short month', () => {
  // After 2026-08-31 09:00 Bangkok has passed → September clamps 31 → 30.
  const next = computeNextOccurrence(
    { freq: 'monthly', day: 31, time: '09:00' },
    new Date('2026-08-31T03:00:00Z'), // 10:00 Bangkok, past the slot
  );
  assert.equal(next.toISOString(), '2026-09-30T02:00:00.000Z');
});

test('monthly: crosses a year boundary', () => {
  const next = computeNextOccurrence(
    { freq: 'monthly', day: 5, time: '09:00' },
    new Date('2026-12-20T00:00:00Z'),
  );
  assert.equal(next.toISOString(), '2027-01-05T02:00:00.000Z');
});
