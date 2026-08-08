/**
 * push_enabled — the product-wide LINE push kill switch (migration 059).
 *
 * WHY THIS IS A TABLE AND NOT AN ENV VAR. TASK_NOTIFICATIONS_ENABLED already
 * exists and is the right shape for a DEPLOY-time decision. This is the
 * INCIDENT-time one: when reminders are misfiring at 02:00 or the monthly push
 * allowance is burning down faster than it should, an admin needs one click
 * that stops every push in BOTH processes within a minute. An env var is
 * per-Railway-service (CLAUDE.md §13), has to be set twice, and only takes
 * effect on restart. A row does not.
 *
 * The two switches compose, they do not replace each other: a push goes out
 * only when TASK_NOTIFICATIONS_ENABLED is on AND push_enabled is true.
 * TASK_NOTIFICATIONS_ENABLED still gates SCHEDULING (no reminder rows, no
 * delayed jobs); this one gates DELIVERY at the last possible moment inside
 * pushMessage(), so a flip takes effect on jobs already queued and in flight.
 *
 * ── FAIL OPEN, deliberately ─────────────────────────────────────────────────
 *
 * getPushEnabled() returns TRUE on every error — Redis down, Supabase blip,
 * migration 059 not applied, row missing, unparseable value. This is the
 * opposite of the fail-CLOSED posture the TIER 2 write endpoints take, and the
 * asymmetry is the point: a failed admin write is visible and retryable, while
 * a Supabase hiccup that silently muted every task reminder would look exactly
 * like a working product right up until users notice nobody was reminded. The
 * switch is an explicit human decision to go quiet; an outage is not.
 *
 * ── Caching ─────────────────────────────────────────────────────────────────
 *
 * pushMessage() is called once per reminder, behind the task worker's
 * 10/second limiter, so an uncached read would be a Supabase round trip per
 * push. Redis caches the resolved boolean for 300 s under `settings:push_enabled`.
 * setPushEnabled() DELETES the key rather than overwriting it, so the next read
 * re-derives from the DB and a flip takes effect at once — the TTL only bounds
 * the FALLBACK staleness window if that explicit DELETE were itself lost. Raised
 * 60 s → 300 s purely to cut Upstash reads (this key is read on every push);
 * correctness is unchanged because the DELETE, not the TTL, makes a flip prompt.
 *
 * Worst case after a flip WHOSE INVALIDATION WAS LOST: 300 s of pushes on the
 * old setting, in the API and the worker independently. That is the accepted
 * cost of not reading the DB on every push, and it is bounded.
 *
 * Clients are LAZY SINGLETONS (same idiom as pending-notify.service and
 * progress-store): this module is imported by line.service.ts, which the LIFF-
 * facing routes, the webhook and all three workers pull in. Constructing a
 * Supabase client or a Redis connection at import time would open sockets in
 * every one of them, and would break the unit tests that import line.service
 * transitively.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Redis } from 'ioredis';
import { config } from '../config';
import { createRedis } from '../plugins/redis';
import { requireAdminAction } from './admin-audit.service';

const CACHE_KEY = 'settings:push_enabled';
// Fallback staleness window only — the explicit DELETE in setPushEnabled is what
// makes a flip prompt. Raised 60 → 300 to cut per-push Upstash reads 5x.
const CACHE_TTL_SECONDS = 300;
const SETTING_KEY = 'push_enabled';

/**
 * The three cache operations this module needs, behind an interface.
 *
 * Not an abstraction for its own sake: the fail-open behaviour is the whole
 * safety property of this file, and the only way to test "a dead Redis still
 * lets pushes through" is to hand it a client that throws. An interface with a
 * test override is the smallest seam that makes that provable, and it costs the
 * production path one indirection.
 */
export interface PushFlagCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

let redisClient: Redis | null = null;
let cacheOverride: PushFlagCache | null = null;

function cache(): PushFlagCache {
  if (cacheOverride) return cacheOverride;
  if (!redisClient) redisClient = createRedis();
  const client = redisClient;
  return {
    get: (key) => client.get(key),
    set: async (key, value, ttlSeconds) => {
      await client.set(key, value, 'EX', ttlSeconds);
    },
    del: async (key) => {
      await client.del(key);
    },
  };
}

/**
 * TEST SEAM. Replace the cache with a fake, or pass null to restore Redis.
 * Nothing outside *.test.ts may call this.
 */
export function __setPushFlagCacheForTests(impl: PushFlagCache | null): void {
  cacheOverride = impl;
}

let supabaseClient: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  if (!supabaseClient) {
    supabaseClient = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return supabaseClient;
}

/**
 * Read the switch. Never throws; returns true on any failure (see the fail-open
 * note in the header).
 *
 * Only the exact JSON literal `false` turns pushes off. A missing row, a NULL,
 * a string, a number — anything that is not literally `false` — is read as ON,
 * so a malformed write can never mute the product.
 *
 * `db` is optional and defaults to this module's lazy service-role client. The
 * push path never passes one; the tests do.
 */
export async function getPushEnabled(db?: SupabaseClient): Promise<boolean> {
  try {
    const cached = await cache().get(CACHE_KEY);
    if (cached !== null) return cached !== '0';
  } catch (err) {
    // Cache miss by way of an outage. Fall through to the DB rather than
    // returning early — Redis being down says nothing about the setting.
    console.warn('[push-flag] cache read failed, falling through to DB:', err);
  }

  let enabled = true;
  try {
    const { data, error } = await (db ?? supabase())
      .from('system_settings')
      .select('value')
      .eq('key', SETTING_KEY)
      .maybeSingle();
    if (error) throw error;
    // `data.value` is JSONB: supabase-js hands back a real boolean for `true`
    // / `false`. Anything else (missing row, unexpected shape) stays ON.
    enabled = (data as { value?: unknown } | null)?.value === false ? false : true;
  } catch (err) {
    console.error('[push-flag] DB read failed — failing OPEN (push stays enabled):', err);
    // Deliberately NOT cached: caching a fail-open guess would extend one blip
    // into a minute of pretending we know the answer.
    return true;
  }

  try {
    await cache().set(CACHE_KEY, enabled ? '1' : '0', CACHE_TTL_SECONDS);
  } catch (err) {
    console.warn('[push-flag] cache write failed (harmless, next read re-derives):', err);
  }
  return enabled;
}

/**
 * Read the switch straight from the DB, bypassing the cache. Throws on a read
 * error — unlike {@link getPushEnabled}, whose job is to keep pushes flowing
 * through a blip, this one exists to tell an ADMIN the truth, and a stale or
 * invented answer on the settings page is worse than an error banner.
 *
 * Takes the caller's client (the Fastify-decorated one on the route path) so an
 * admin read does not open the lazy singleton this module keeps for the push
 * path.
 */
export async function readPushEnabledUncached(db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db
    .from('system_settings')
    .select('value')
    .eq('key', SETTING_KEY)
    .maybeSingle();
  if (error) throw error;
  // Same rule as the cached read: only a literal `false` is off. A missing row
  // is ON, which is the seeded state migration 059 creates.
  return (data as { value?: unknown } | null)?.value === false ? false : true;
}

/**
 * Flip the switch and record who did it.
 *
 * Order is load-bearing: write the row, invalidate the cache, THEN audit. The
 * audit is last because it is the step allowed to fail the request — and this
 * write is cheaply reversible, so the caller reverts to the previous value
 * before the AdminAuditError propagates (see admin-audit.service's compensation
 * contract). Cache invalidation sits in the middle so that even a request that
 * ends in a 500 leaves Redis consistent with whatever ended up in the DB.
 *
 * Throws on a DB failure and on an audit failure. The caller (PUT
 * /admin/settings/push_enabled) owns the revert.
 */
export async function setPushEnabled(
  value: boolean,
  db: SupabaseClient,
  adminLineId: string,
): Promise<void> {
  const { data: prior, error: readErr } = await db
    .from('system_settings')
    .select('value')
    .eq('key', SETTING_KEY)
    .maybeSingle();
  if (readErr) throw readErr;
  const before = (prior as { value?: unknown } | null)?.value === false ? false : true;

  const { error } = await db
    .from('system_settings')
    .upsert(
      {
        key: SETTING_KEY,
        value: value,
        updated_by: adminLineId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'key' },
    );
  if (error) throw error;

  await invalidatePushEnabledCache();

  await requireAdminAction({
    supabase: db,
    adminLineId,
    action: 'setting_push_enabled',
    targetType: 'setting',
    targetId: SETTING_KEY,
    before: { pushEnabled: before },
    after: { pushEnabled: value },
  });
}

/**
 * Drop the cached value so the next read re-derives from the DB.
 *
 * Exported because the route's compensating revert needs it too: after writing
 * the old value back it must not leave the cache holding the value the failed
 * request tried to set. Never throws — a failed DELETE only means up to 60 s of
 * staleness, which is the same bound the TTL already imposes.
 */
export async function invalidatePushEnabledCache(): Promise<void> {
  try {
    await cache().del(CACHE_KEY);
  } catch (err) {
    console.warn('[push-flag] cache invalidation failed (TTL will expire it):', err);
  }
}

/** Release the lazy Redis connection. Mirrors closePendingNotify(). */
export async function closePushFlag(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
