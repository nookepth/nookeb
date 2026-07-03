import { Redis } from 'ioredis';
import { createRedis } from '../plugins/redis';

/**
 * Batch upload progress store, read by GET /progress/:batchId and written by the
 * upload worker. Backed by Redis (NOT an in-memory Map) because the API and the
 * worker run as SEPARATE processes — see "Running Locally" in CLAUDE.md — so
 * process-local state written by the worker would be invisible to the API route.
 *
 * Keys: `progress:{batchId}` hash { current, total, status }.
 * Cleanup: 1h safety TTL from init; tightened to 10min once complete.
 */
const SAFETY_TTL_S = 60 * 60;
const DONE_TTL_S = 10 * 60;

export interface BatchProgress {
  current: number;
  total: number;
  status: 'processing' | 'done';
}

let client: Redis | null = null;
function redis(): Redis {
  if (!client) client = createRedis();
  return client;
}

function key(batchId: string): string {
  return `progress:${batchId}`;
}

export async function init(batchId: string, total: number): Promise<void> {
  const k = key(batchId);
  await redis()
    .multi()
    .hset(k, { current: 0, total, status: 'processing' })
    .expire(k, SAFETY_TTL_S)
    .exec();
}

export async function increment(batchId: string): Promise<void> {
  await redis().hincrby(key(batchId), 'current', 1);
}

export async function complete(batchId: string): Promise<void> {
  const k = key(batchId);
  await redis().multi().hset(k, 'status', 'done').expire(k, DONE_TTL_S).exec();
}

export async function get(batchId: string): Promise<BatchProgress | null> {
  const data = await redis().hgetall(key(batchId));
  if (!data || data.total === undefined) return null;
  return {
    current: Number(data.current ?? 0),
    total: Number(data.total),
    status: data.status === 'done' ? 'done' : 'processing',
  };
}

export async function closeProgressStore(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
