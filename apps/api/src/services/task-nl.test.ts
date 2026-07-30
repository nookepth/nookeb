import { test } from 'node:test';
import assert from 'node:assert/strict';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { BANGKOK_TZ, type LineMentionee } from './task-command';
import { detectNaturalTask } from './task-nl';

dayjs.extend(utc);
dayjs.extend(timezone);

// Same fixed "now" as task-command.test.ts: 2025-06-15 10:00 Bangkok.
const NOW = dayjs.tz('2025-06-15 10:00', BANGKOK_TZ).valueOf();

/** Build an UN-prefixed "@name <body>" message with a mention span over "@name". */
function nlMsg(
  name: string,
  userId: string | undefined,
  body: string,
): { text: string; mentionees: LineMentionee[] } {
  const at = `@${name}`;
  const text = `${at} ${body}`;
  return {
    text,
    mentionees: [{ index: 0, length: at.length, type: 'user', ...(userId ? { userId } : {}) }],
  };
}

// ---- HIGH confidence: assignee + title + due clause ----

test('detectNaturalTask: HIGH — assignee + title + due goes straight to confirm', () => {
  const { text, mentionees } = nlMsg('Bob', 'U1', 'ทำสไลด์ ส่งพรุ่งนี้ 17:00');
  const r = detectNaturalTask({ text, mentionees, nowMs: NOW });
  assert.ok(r);
  assert.equal(r!.confidence, 'high');
  assert.deepEqual(r!.assigneeUids, ['U1']);
  assert.equal(r!.title, 'ทำสไลด์');
  assert.ok(r!.dueIso);
  assert.equal(dayjs(r!.dueIso).tz(BANGKOK_TZ).format('YYYY-MM-DD HH:mm'), '2025-06-16 17:00');
});

test('detectNaturalTask: HIGH — reminder clause parsed, stripped from title', () => {
  const { text, mentionees } = nlMsg('Bob', 'U1', 'ทำสไลด์ ส่งพรุ่งนี้ เตือน 2 ครั้ง');
  const r = detectNaturalTask({ text, mentionees, nowMs: NOW });
  assert.ok(r);
  assert.equal(r!.confidence, 'high');
  assert.equal(r!.title, 'ทำสไลด์');
  assert.equal(r!.reminderCount, 2);
});

// ---- MEDIUM confidence: assignee + task-shaped title, no due ----

test('detectNaturalTask: MEDIUM — task verb, no due → ask for due date', () => {
  const { text, mentionees } = nlMsg('Bob', 'U1', 'ช่วยทำสไลด์หน่อย');
  const r = detectNaturalTask({ text, mentionees, nowMs: NOW });
  assert.ok(r);
  assert.equal(r!.confidence, 'medium');
  assert.deepEqual(r!.assigneeUids, ['U1']);
  assert.equal(r!.dueIso, undefined);
  assert.ok(r!.title.includes('ทำสไลด์'));
});

// ---- LOW confidence: silent ignore (null) ----

test('detectNaturalTask: LOW — mention + non-task chatter is ignored', () => {
  const { text, mentionees } = nlMsg('Bob', 'U1', 'โอเคเลย');
  assert.equal(detectNaturalTask({ text, mentionees, nowMs: NOW }), null);
});

test('detectNaturalTask: LOW — mention with no body is ignored', () => {
  const { text, mentionees } = nlMsg('Bob', 'U1', '');
  assert.equal(detectNaturalTask({ text, mentionees, nowMs: NOW }), null);
});

test('detectNaturalTask: LOW — @all is never a natural task', () => {
  const text = '@all ประชุมกันหน่อย ส่งพรุ่งนี้';
  const r = detectNaturalTask({
    text,
    mentionees: [{ index: 0, length: 4, type: 'all' }],
    nowMs: NOW,
  });
  assert.equal(r, null);
});

test('detectNaturalTask: LOW — a mention LINE cannot resolve (no userId) is ignored', () => {
  const { text, mentionees } = nlMsg('ghost', undefined, 'ทำสไลด์ ส่งพรุ่งนี้');
  assert.equal(detectNaturalTask({ text, mentionees, nowMs: NOW }), null);
});

test('detectNaturalTask: past due clause with no title falls to LOW, not HIGH', () => {
  // Only a past date + no real title → not a confident task.
  const { text, mentionees } = nlMsg('Bob', 'U1', 'ส่ง 01/01/2020');
  assert.equal(detectNaturalTask({ text, mentionees, nowMs: NOW }), null);
});
