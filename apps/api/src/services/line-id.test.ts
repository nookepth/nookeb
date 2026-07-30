import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { LINE_CHAT_ID_MESSAGE, LINE_CHAT_ID_RE } from './line-id';

/**
 * Server-side shape guard for client-supplied group ids. The route schemas in
 * routes/tasks.ts, routes/groups.ts and routes/team.router.ts all build exactly
 * this validator, so a rejection here is the 400 those routes return.
 */
const groupIdSchema = z.string().regex(LINE_CHAT_ID_RE, LINE_CHAT_ID_MESSAGE);

const GROUP_ID = 'Cabcdef1234567890abcdef1234567890';
const ROOM_ID = 'Rabcdef1234567890abcdef1234567890';
const USER_ID = 'Uabcdef1234567890abcdef1234567890';

test('accepts a real LINE group id (C + 32 hex)', () => {
  assert.equal(groupIdSchema.safeParse(GROUP_ID).success, true);
});

test('accepts a real LINE room id (R + 32 hex)', () => {
  assert.equal(groupIdSchema.safeParse(ROOM_ID).success, true);
});

// The finding this guards: a U... id reaching tasks.group_line_id would let the
// task announcement push a Flex card into that person's private chat with the OA
// (migration 043). It must never validate.
test('rejects a LINE USER id (U + 32 hex)', () => {
  const result = groupIdSchema.safeParse(USER_ID);
  assert.equal(result.success, false);
  assert.equal(result.error!.issues[0]!.message, LINE_CHAT_ID_MESSAGE);
});

test('rejects an empty string', () => {
  assert.equal(groupIdSchema.safeParse('').success, false);
});

test('rejects other malformed ids', () => {
  for (const bad of [
    'Cabcdef1234567890abcdef123456789', // 31 hex — too short
    'Cabcdef1234567890abcdef12345678900', // 33 hex — too long
    'CABCDEF1234567890ABCDEF1234567890', // uppercase hex is not LINE's shape
    'Cabcdefg234567890abcdef1234567890', // 'g' is not hex
    'cabcdef1234567890abcdef1234567890', // lowercase prefix
    '00000000-0000-4000-8000-000000000000', // MINI App pseudo (UUID) chat id
    ` ${GROUP_ID}`,
    `${GROUP_ID}\n`,
    `${GROUP_ID}${GROUP_ID}`,
  ]) {
    assert.equal(groupIdSchema.safeParse(bad).success, false, `should reject: ${bad}`);
  }
});
