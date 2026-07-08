import { Redis } from 'ioredis';
import { createRedis } from '../plugins/redis';
import type { LineMessage } from './line.service';

/**
 * Deferred-notification store — the quota-safe fallback of the reply-only
 * messaging rule (see "LINE Messaging — Critical Rules" in CLAUDE.md). Workers
 * finish long jobs AFTER the triggering event's reply token is spent or
 * expired, and push messages are banned (they burn the monthly Messaging API
 * quota and fail silently once it runs out). So instead of pushing, callers
 * queue the would-be message here; the webhook drains the queue on the user's
 * next 1-on-1 text/postback interaction and PREPENDS the messages to that
 * interaction's reply — free, quota-proof delivery on the next touchpoint.
 *
 * Backed by Redis (same reasoning as progress-store: the API and the worker
 * are separate processes, so an in-memory store in one is invisible to the
 * other). Key `notify:pending:{lineUserId}` — a list of JSON-serialized
 * LineMessages, capped so a drained batch always fits LINE's 5-messages-per-
 * reply limit alongside the interaction's own reply.
 */

/** Newest messages kept per user (a reply carries at most 5 messages total). */
const MAX_PENDING = 4;
/** Undelivered notices expire after a week — stale ones are worse than none. */
const TTL_S = 7 * 24 * 60 * 60;

let client: Redis | null = null;
function redis(): Redis {
  if (!client) client = createRedis();
  return client;
}

const key = (lineUserId: string): string => `notify:pending:${lineUserId}`;

/**
 * Queue messages for delivery on the user's next interaction. Never throws —
 * a lost notification must not fail the job that produced it (the real work is
 * already committed by the time anything notifies; surfacing is best-effort,
 * exactly like the old pushes were).
 */
export async function addPendingNotify(lineUserId: string, messages: LineMessage[]): Promise<void> {
  if (messages.length === 0) return;
  try {
    const k = key(lineUserId);
    await redis()
      .multi()
      .rpush(k, ...messages.map((m) => JSON.stringify(m)))
      .ltrim(k, -MAX_PENDING, -1)
      .expire(k, TTL_S)
      .exec();
  } catch (err) {
    console.error(`[pending-notify] enqueue failed for ${lineUserId}:`, err);
  }
}

/**
 * Atomically take (and clear) the user's pending messages, oldest first.
 * Returns [] on any error — the webhook must never fail an interaction over
 * a notification drain.
 */
export async function drainPendingNotify(lineUserId: string): Promise<LineMessage[]> {
  try {
    const k = key(lineUserId);
    const results = await redis().multi().lrange(k, 0, -1).del(k).exec();
    const raw = (results?.[0]?.[1] as string[] | undefined) ?? [];
    const out: LineMessage[] = [];
    for (const item of raw) {
      try {
        out.push(JSON.parse(item) as LineMessage);
      } catch {
        // corrupt entry — skip it rather than blocking the rest
      }
    }
    return out;
  } catch (err) {
    console.error(`[pending-notify] drain failed for ${lineUserId}:`, err);
    return [];
  }
}

export async function closePendingNotify(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
