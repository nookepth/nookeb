import { test } from 'node:test';
import assert from 'node:assert/strict';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import {
  BANGKOK_TZ,
  matchDueExpression,
  parseTaskCommand,
  selectRemindTypes,
  stripMentions,
  type LineMentionee,
} from './task-command';

dayjs.extend(utc);
dayjs.extend(timezone);

// A fixed "now": 2025-06-15 10:00 Bangkok (UTC 03:00). All relative-date
// assertions are anchored to this instant so the tests are deterministic.
const NOW = dayjs.tz('2025-06-15 10:00', BANGKOK_TZ).valueOf();

/** Build a "@name " prefix + body, with a matching mention span over "@name". */
function withMention(
  name: string,
  userId: string | undefined,
  body: string,
  command = 'หนูเก็บเตือนงาน',
): {
  text: string;
  mentionees: LineMentionee[];
} {
  const at = `@${name}`;
  const text = `${command} ${at} ${body}`;
  const index = text.indexOf(at);
  return {
    text,
    mentionees: [{ index, length: at.length, type: 'user', ...(userId ? { userId } : {}) }],
  };
}

// ---- stripMentions ----

test('stripMentions removes spans right-to-left, keeps the rest', () => {
  const text = 'หนูเก็บเตือนงาน @Ann @Bob ทำสไลด์';
  const a = text.indexOf('@Ann');
  const b = text.indexOf('@Bob');
  const out = stripMentions(text, [
    { index: a, length: 4, type: 'user', userId: 'U1' },
    { index: b, length: 4, type: 'user', userId: 'U2' },
  ]);
  assert.ok(!out.includes('@Ann'));
  assert.ok(!out.includes('@Bob'));
  assert.ok(out.includes('ทำสไลด์'));
});

test('stripMentions skips an out-of-range span instead of throwing', () => {
  const out = stripMentions('สั้น', [{ index: 100, length: 5, type: 'user', userId: 'U1' }]);
  assert.equal(out, 'สั้น');
});

// ---- matchDueExpression ----

test('matchDueExpression: พรุ่งนี้ + explicit time', () => {
  const r = matchDueExpression('พรุ่งนี้ 17:00', NOW);
  assert.ok(r);
  const d = dayjs(r!.date).tz(BANGKOK_TZ);
  assert.equal(d.format('YYYY-MM-DD HH:mm'), '2025-06-16 17:00');
});

test('matchDueExpression: date only defaults to 18:00', () => {
  const r = matchDueExpression('20/06', NOW);
  assert.ok(r);
  const d = dayjs(r!.date).tz(BANGKOK_TZ);
  assert.equal(d.format('YYYY-MM-DD HH:mm'), '2025-06-20 18:00');
});

test('matchDueExpression: Buddhist year is converted (2568 → 2025)', () => {
  const r = matchDueExpression('25/12/2568', NOW);
  assert.ok(r);
  assert.equal(dayjs(r!.date).tz(BANGKOK_TZ).format('YYYY-MM-DD'), '2025-12-25');
});

test('matchDueExpression: 2-digit Buddhist short year (68 → 2025)', () => {
  const r = matchDueExpression('25/12/68', NOW);
  assert.ok(r);
  assert.equal(dayjs(r!.date).tz(BANGKOK_TZ).year(), 2025);
});

test('matchDueExpression: อีก 3 วัน', () => {
  const r = matchDueExpression('อีก 3 วัน', NOW);
  assert.ok(r);
  assert.equal(dayjs(r!.date).tz(BANGKOK_TZ).format('YYYY-MM-DD HH:mm'), '2025-06-18 18:00');
});

test('matchDueExpression: bare past date rolls to next year', () => {
  const r = matchDueExpression('01/01', NOW); // Jan 1 already passed in June
  assert.ok(r);
  assert.equal(dayjs(r!.date).tz(BANGKOK_TZ).year(), 2026);
});

test('matchDueExpression: invalid day/month rejected', () => {
  assert.equal(matchDueExpression('31/04', NOW), null); // April has 30 days
  assert.equal(matchDueExpression('40/13', NOW), null);
});

test('matchDueExpression: non-date text is not a match', () => {
  assert.equal(matchDueExpression('รายงาน', NOW), null);
});

// ---- selectRemindTypes ----

test('selectRemindTypes: null = full default schedule', () => {
  assert.deepEqual(selectRemindTypes(null), ['1_day', '3_hours', 'overdue', '3_days']);
});

test('selectRemindTypes: count picks the first N by priority, clamped', () => {
  assert.deepEqual(selectRemindTypes(1), ['1_day']);
  assert.deepEqual(selectRemindTypes(2), ['1_day', '3_hours']);
  assert.deepEqual(selectRemindTypes(99), ['1_day', '3_hours', 'overdue', '3_days']);
  assert.deepEqual(selectRemindTypes(0), ['1_day']); // clamped up to 1
});

// ---- parseTaskCommand: happy paths ----

test('parseTaskCommand: single assignee + title + relative due', () => {
  const { text, mentionees } = withMention('สมชาย', 'Uabc', 'ทำสไลด์ ส่งพรุ่งนี้ 17:00');
  const r = parseTaskCommand({ text, mentionees, nowMs: NOW });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.value.assigneeUids, ['Uabc']);
  assert.equal(r.value.title, 'ทำสไลด์');
  assert.equal(dayjs(r.value.dueIso).tz(BANGKOK_TZ).format('YYYY-MM-DD HH:mm'), '2025-06-16 17:00');
  assert.equal(r.value.reminderCount, null);
});

test('parseTaskCommand: two assignees + reminder count, deduped', () => {
  const text = 'หนูเก็บเตือนงาน @Ann @Bob @Ann สรุปยอดขาย ส่ง 25/12 18:00 เตือน 3 ครั้ง';
  const a = text.indexOf('@Ann');
  const b = text.indexOf('@Bob');
  const a2 = text.lastIndexOf('@Ann');
  const r = parseTaskCommand({
    text,
    mentionees: [
      { index: a, length: 4, type: 'user', userId: 'U1' },
      { index: b, length: 4, type: 'user', userId: 'U2' },
      { index: a2, length: 4, type: 'user', userId: 'U1' },
    ],
    nowMs: NOW,
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.value.assigneeUids, ['U1', 'U2']);
  assert.equal(r.value.title, 'สรุปยอดขาย');
  assert.equal(r.value.reminderCount, 3);
});

test('parseTaskCommand: legacy "สั่งงาน" command word still parses', () => {
  const { text, mentionees } = withMention(
    'สมชาย',
    'Uabc',
    'ทำสไลด์ ส่งพรุ่งนี้ 17:00',
    'หนูเก็บสั่งงาน',
  );
  const r = parseTaskCommand({ text, mentionees, nowMs: NOW });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.title, 'ทำสไลด์');
});

test('parseTaskCommand: "เตือนงาน" command word is not swallowed as a reminder clause', () => {
  // The leading trigger "เตือนงาน" and the trailing "เตือน N ครั้ง" clause must
  // stay distinct — the command word is stripped, the clause sets the count.
  const { text, mentionees } = withMention('สมชาย', 'Uabc', 'ทำสไลด์ ส่งพรุ่งนี้ เตือน 2 ครั้ง');
  const r = parseTaskCommand({ text, mentionees, nowMs: NOW });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.title, 'ทำสไลด์');
  assert.equal(r.value.reminderCount, 2);
});

test('parseTaskCommand: "กำหนดส่ง" keyword leaves no residue in the title', () => {
  const { text, mentionees } = withMention('สมชาย', 'Uabc', 'ส่งรายงานประจำเดือน กำหนดส่ง 20/06');
  const r = parseTaskCommand({ text, mentionees, nowMs: NOW });
  assert.ok(r.ok);
  if (!r.ok) return;
  // "ส่งรายงาน..." at the start must NOT be swallowed as the due keyword — the
  // real due clause is the trailing "กำหนดส่ง 20/06".
  assert.equal(r.value.title, 'ส่งรายงานประจำเดือน');
  assert.equal(dayjs(r.value.dueIso).tz(BANGKOK_TZ).format('YYYY-MM-DD'), '2025-06-20');
});

// ---- parseTaskCommand: error paths ----

test('parseTaskCommand: @all is rejected', () => {
  const text = 'หนูเก็บเตือนงาน @all ทำงาน ส่งพรุ่งนี้';
  const r = parseTaskCommand({
    text,
    mentionees: [{ index: text.indexOf('@all'), length: 4, type: 'all' }],
    nowMs: NOW,
  });
  assert.deepEqual(r, { ok: false, code: 'mention_all' });
});

test('parseTaskCommand: mention without userId is unresolved', () => {
  const { text, mentionees } = withMention('ghost', undefined, 'ทำงาน ส่งพรุ่งนี้');
  const r = parseTaskCommand({ text, mentionees, nowMs: NOW });
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.equal(r.code, 'unresolved_mention');
  assert.equal(r.unresolvedCount, 1);
});

test('parseTaskCommand: no mention at all', () => {
  const r = parseTaskCommand({ text: 'หนูเก็บเตือนงาน ทำงาน ส่งพรุ่งนี้', mentionees: [], nowMs: NOW });
  assert.deepEqual(r, { ok: false, code: 'no_assignee' });
});

test('parseTaskCommand: missing due clause', () => {
  const { text, mentionees } = withMention('สมชาย', 'Uabc', 'ทำสไลด์ให้เสร็จ');
  const r = parseTaskCommand({ text, mentionees, nowMs: NOW });
  assert.deepEqual(r, { ok: false, code: 'missing_due' });
});

test('parseTaskCommand: due keyword present but unparseable → invalid_due', () => {
  const { text, mentionees } = withMention('สมชาย', 'Uabc', 'ทำสไลด์ ส่งเร็วๆนี้');
  const r = parseTaskCommand({ text, mentionees, nowMs: NOW });
  assert.deepEqual(r, { ok: false, code: 'invalid_due' });
});

test('parseTaskCommand: explicit past date → invalid_due', () => {
  const { text, mentionees } = withMention('สมชาย', 'Uabc', 'ทำสไลด์ ส่ง 01/01/2020');
  const r = parseTaskCommand({ text, mentionees, nowMs: NOW });
  assert.deepEqual(r, { ok: false, code: 'invalid_due' });
});

test('parseTaskCommand: title empty after stripping clauses → no_title', () => {
  const { text, mentionees } = withMention('สมชาย', 'Uabc', 'ส่งพรุ่งนี้ 17:00');
  const r = parseTaskCommand({ text, mentionees, nowMs: NOW });
  assert.deepEqual(r, { ok: false, code: 'no_title' });
});
