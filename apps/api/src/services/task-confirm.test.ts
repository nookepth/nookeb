import { test } from 'node:test';
import assert from 'node:assert/strict';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import type { Redis } from 'ioredis';
import { BANGKOK_TZ } from './task-command';
import {
  PENDING_TTL_SECONDS,
  claimPendingConfirm,
  completePartialWithDue,
  confirmKey,
  deletePendingConfirm,
  getPendingConfirm,
  getPendingPartial,
  parseDueReply,
  storePendingConfirm,
  storePendingPartial,
  type PendingTaskConfirm,
  type PendingTaskPartial,
} from './task-confirm';

dayjs.extend(utc);
dayjs.extend(timezone);

const NOW = dayjs.tz('2025-06-15 10:00', BANGKOK_TZ).valueOf();

/**
 * Minimal in-memory Redis honouring the subset the store uses (set/get/getdel/
 * del + EX), with a settable clock so expiry is testable without real time.
 */
class FakeRedis {
  private store = new Map<string, { value: string; expireAt: number | null }>();
  public now = 0;

  async set(key: string, value: string, ...opts: unknown[]): Promise<'OK'> {
    let expireAt: number | null = null;
    for (let i = 0; i < opts.length; i += 1) {
      if (opts[i] === 'EX') expireAt = this.now + Number(opts[i + 1]) * 1000;
    }
    this.store.set(key, { value, expireAt });
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expireAt !== null && this.now >= e.expireAt) {
      this.store.delete(key);
      return null;
    }
    return e.value;
  }
  async getdel(key: string): Promise<string | null> {
    const v = await this.get(key);
    this.store.delete(key);
    return v;
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

function fakeRedis(): { redis: Redis; clock: FakeRedis } {
  const clock = new FakeRedis();
  return { redis: clock as unknown as Redis, clock };
}

const GID = 'Cgroup1';
const CID = 'Ucommander1';

function sampleConfirm(overrides: Partial<PendingTaskConfirm> = {}): PendingTaskConfirm {
  return {
    groupId: GID,
    commanderId: CID,
    assignees: [{ lineUid: 'U1', displayName: 'Bob', pictureUrl: null }],
    title: 'ทำสไลด์',
    dueIso: dayjs.tz('2025-06-16 17:00', BANGKOK_TZ).toISOString(),
    reminderCount: null,
    reminderBlocked: false,
    sourceMessageId: 'msg-1',
    ...overrides,
  };
}

// ---- confirmation flow: happy path ----

test('store → get returns the pending confirmation intact', async () => {
  const { redis } = fakeRedis();
  const intent = sampleConfirm();
  await storePendingConfirm(redis, intent);
  assert.deepEqual(await getPendingConfirm(redis, GID, CID), intent);
});

// ---- expired confirmation ----

test('a confirmation past its TTL reads back as null', async () => {
  const { redis, clock } = fakeRedis();
  await storePendingConfirm(redis, sampleConfirm());
  clock.now += (PENDING_TTL_SECONDS + 1) * 1000; // fast-forward past expiry
  assert.equal(await getPendingConfirm(redis, GID, CID), null);
  // And a confirm-tap after expiry claims nothing.
  assert.equal(await claimPendingConfirm(redis, GID, CID), null);
});

// ---- duplicate command replaces the pending intent ----

test('a second command REPLACES the pending intent for the same group+commander', async () => {
  const { redis } = fakeRedis();
  await storePendingConfirm(redis, sampleConfirm({ title: 'งานแรก', sourceMessageId: 'm1' }));
  await storePendingConfirm(redis, sampleConfirm({ title: 'งานสอง', sourceMessageId: 'm2' }));
  const got = await getPendingConfirm(redis, GID, CID);
  assert.equal(got?.title, 'งานสอง');
  assert.equal(got?.sourceMessageId, 'm2');
});

test('storing a full confirm clears a pending NL partial for the same key', async () => {
  const { redis } = fakeRedis();
  const partial: PendingTaskPartial = {
    groupId: GID,
    commanderId: CID,
    assignees: [{ lineUid: 'U1', displayName: 'Bob', pictureUrl: null }],
    title: 'ทำสไลด์',
    reminderCount: null,
    sourceMessageId: 'm0',
  };
  await storePendingPartial(redis, partial);
  await storePendingConfirm(redis, sampleConfirm());
  assert.equal(await getPendingPartial(redis, GID, CID), null);
});

// ---- claim is exactly-once (double-tap / redelivery safety) ----

test('claim consumes the intent exactly once', async () => {
  const { redis } = fakeRedis();
  await storePendingConfirm(redis, sampleConfirm());
  const first = await claimPendingConfirm(redis, GID, CID);
  assert.ok(first);
  const second = await claimPendingConfirm(redis, GID, CID);
  assert.equal(second, null); // a second tap gets nothing → no double-create
});

// ---- confirm after cancel ----

test('confirm after cancel finds nothing (cancel deleted the pending intent)', async () => {
  const { redis } = fakeRedis();
  await storePendingConfirm(redis, sampleConfirm());
  await deletePendingConfirm(redis, GID, CID); // user tapped ยกเลิก
  assert.equal(await claimPendingConfirm(redis, GID, CID), null); // then tapped ยืนยัน
});

// ---- key builder ----

test('confirmKey binds a pending intent to (group, commander)', () => {
  assert.equal(confirmKey(GID, CID), `nookeb:confirm:${GID}:${CID}`);
});

// ---- pure due-reply completion (NL medium → confirmation) ----

test('parseDueReply reads both a bare date and a keyword-led clause', () => {
  assert.ok(parseDueReply('พรุ่งนี้ 17:00', NOW));
  assert.ok(parseDueReply('25/12', NOW));
  assert.ok(parseDueReply('ส่งพรุ่งนี้', NOW));
  assert.equal(parseDueReply('ขอบคุณนะ', NOW), null); // not a date → null
  assert.equal(parseDueReply('ส่ง 01/01/2020', NOW), null); // past → null
});

test('completePartialWithDue turns a partial + a due reply into a full confirm intent', () => {
  const partial: PendingTaskPartial = {
    groupId: GID,
    commanderId: CID,
    assignees: [{ lineUid: 'U1', displayName: 'Bob', pictureUrl: null }],
    title: 'ทำสไลด์',
    reminderCount: 2,
    sourceMessageId: 'm0',
  };
  const done = completePartialWithDue(partial, 'พรุ่งนี้ 17:00', NOW);
  assert.ok(done);
  assert.equal(done!.title, 'ทำสไลด์');
  assert.equal(done!.reminderCount, 2);
  assert.deepEqual(done!.assignees, partial.assignees);
  assert.equal(dayjs(done!.dueIso).tz(BANGKOK_TZ).format('YYYY-MM-DD HH:mm'), '2025-06-16 17:00');
});

test('completePartialWithDue returns null when the reply is not a date', () => {
  const partial: PendingTaskPartial = {
    groupId: GID,
    commanderId: CID,
    assignees: [],
    title: 'ทำสไลด์',
    reminderCount: null,
    sourceMessageId: 'm0',
  };
  assert.equal(completePartialWithDue(partial, 'เดี๋ยวมาคุยกัน', NOW), null);
});
