/**
 * DB-backed feature flags (migrations 059 + 061) — the general case of what
 * push-flag.service.ts is for one key.
 *
 * WHY NOT ENV VARS. Read the header of push-flag.service.ts; the argument is
 * the same and it was already won once. Env vars are per-Railway-service
 * (CLAUDE.md §13), so every flag has to be set twice, and neither takes effect
 * without a restart. That is the right shape for a DEPLOY-time decision and the
 * wrong shape for the moment สแกน is shipping mangled pages and someone needs
 * the enhancement pipeline off in both processes in the next minute. There is
 * precedent for exactly that incident: a flipped SCAN_ENHANCE_ENABLED on the
 * worker service silently shipped unprocessed scans, and finding out took a
 * forensic look at JPEG encoding.
 *
 * ── FAIL OPEN — with a caller-supplied fallback ────────────────────────────
 *
 * getFlag(key, fallback) returns `fallback` on ANY failure: Redis down,
 * Supabase blip, migration 061 unapplied, row missing, unparseable value. The
 * fallback is a parameter rather than a constant because the safe direction
 * differs per flag — a missing scan_enhance_enabled should read TRUE (keep
 * enhancing) while a missing diary_reminder_enabled should read FALSE (do not
 * start messaging people). Each call site names its own safe direction, which
 * is also, deliberately, the value the env var used to resolve to.
 *
 * The asymmetry with the TIER 2 WRITE endpoints is the same one 059 documented:
 * a failed admin write is visible and retryable; a Supabase hiccup that
 * silently changed how the product behaves is not.
 *
 * ── Caching ───────────────────────────────────────────────────────────────
 *
 * 60 s in Redis per key, under `flag:{key}`. Same TTL and same reasoning as the
 * push switch and the auth middleware's session_version cache — bounded
 * staleness in exchange for not hitting Postgres on every scan page. setFlag()
 * DELETES the key rather than overwriting it, so a failed cache write cannot
 * pin a stale value for a minute; the next read re-derives.
 *
 * Worst case after a flip: 60 s on the old value, independently in the API and
 * the worker. Bounded, and the accepted cost.
 *
 * ── This file does NOT own push_enabled ───────────────────────────────────
 *
 * push_enabled lives in the same table but keeps its own module, its own cache
 * key (`settings:push_enabled`) and its own uncached admin read. Not an
 * oversight: it is read once per push behind the reminder worker's 10/s
 * limiter, it fails open with no caller choice in the matter, and its writer
 * carries a compensating revert the generic setFlag below has no business
 * imitating. PUT /admin/flags/push_enabled therefore DELEGATES to
 * setPushEnabled rather than routing through here — one key, one writer.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@supabase/supabase-js';
import type { Redis } from 'ioredis';
import { config } from '../config';
import { createRedis } from '../plugins/redis';
import { requireAdminAction } from './admin-audit.service';

const CACHE_TTL_SECONDS = 60;
const cacheKey = (key: string): string => `flag:${key}`;

/**
 * Every flag this module may read or write, and what it controls.
 *
 * A closed set rather than an open key/value store: `system_settings` is a
 * generic table, but an admin endpoint that accepts any key would let a typo
 * create a row that nothing reads and that looks, on the settings page, exactly
 * like a real switch. PUT /admin/flags/:key validates against this list and
 * 400s anything else.
 *
 * push_enabled is included because it belongs on the same page and the same
 * endpoint — but see the note in the header: its WRITE is delegated.
 */
export const FEATURE_FLAG_KEYS = [
  'push_enabled',
  'diary_reminder_enabled',
  'diary_addon_enabled',
  'scan_enhance_enabled',
  'scan_ocr_enabled',
  'virus_scan_enabled',
] as const;

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

/**
 * The safe direction for each flag when the DB and cache are both unreachable.
 *
 * These match what the corresponding env var resolved to before TIER 3, so a
 * total outage puts the product back exactly where it was rather than somewhere
 * new. Exported so the routes and the admin page render the same defaults this
 * module falls back to instead of hardcoding a second copy.
 */
export const FEATURE_FLAG_FALLBACKS: Record<FeatureFlagKey, boolean> = {
  push_enabled: true,
  diary_reminder_enabled: false,
  diary_addon_enabled: true,
  scan_enhance_enabled: true,
  scan_ocr_enabled: true,
  virus_scan_enabled: true,
};

export function isFeatureFlagKey(key: string): key is FeatureFlagKey {
  return (FEATURE_FLAG_KEYS as readonly string[]).includes(key);
}

/**
 * The three cache operations, behind an interface — the same seam, for the same
 * reason, as PushFlagCache: the fail-open behaviour is the safety property of
 * this file, and proving "a dead Redis still returns the fallback" requires a
 * client that throws.
 */
export interface FeatureFlagCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

let redisClient: Redis | null = null;
let cacheOverride: FeatureFlagCache | null = null;

function cache(): FeatureFlagCache {
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

/** TEST SEAM. Pass null to restore Redis. Nothing outside *.test.ts may call this. */
export function __setFeatureFlagCacheForTests(impl: FeatureFlagCache | null): void {
  cacheOverride = impl;
}

let supabaseClient: SupabaseClient | null = null;
let dbOverride: SupabaseClient | null = null;

function db(): SupabaseClient {
  if (dbOverride) return dbOverride;
  if (!supabaseClient) {
    supabaseClient = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return supabaseClient;
}

/** TEST SEAM for the read path, which takes no client. Pass null to restore. */
export function __setFeatureFlagDbForTests(impl: SupabaseClient | null): void {
  dbOverride = impl;
}

/**
 * Read one flag. NEVER THROWS; returns `fallback` on any failure.
 *
 * Only the JSON literals `true` and `false` are honoured. Anything else — a
 * string, a number, an object, a NULL — falls back, rather than being coerced:
 * `Boolean("false")` is true, and a flag system where a malformed write flips
 * the switch the wrong way is worse than one that ignores it.
 *
 * `fallback` is NOT cached when it comes from a failure. Caching a guess would
 * turn one blip into a full minute of pretending we know the answer, and would
 * outlive the outage that caused it. A genuine read of a missing row is also
 * left uncached for the same reason — the row may be about to be seeded.
 */
export async function getFlag(key: string, fallback: boolean): Promise<boolean> {
  try {
    const cached = await cache().get(cacheKey(key));
    if (cached !== null) return cached === '1';
  } catch (err) {
    // Redis being down says nothing about the setting — fall through to the DB.
    console.warn(`[flags] cache read failed for ${key}, falling through to DB:`, err);
  }

  let value: unknown;
  try {
    const { data, error } = await db()
      .from('system_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) throw error;
    value = (data as { value?: unknown } | null)?.value;
  } catch (err) {
    console.error(`[flags] DB read failed for ${key} — falling back to ${fallback}:`, err);
    return fallback;
  }

  if (typeof value !== 'boolean') {
    // Missing row (061 unapplied, or a key nobody has set) or a malformed
    // value. Not cached: the row may be seeded a second from now.
    return fallback;
  }

  try {
    await cache().set(cacheKey(key), value ? '1' : '0', CACHE_TTL_SECONDS);
  } catch (err) {
    console.warn(`[flags] cache write failed for ${key} (harmless, next read re-derives):`, err);
  }
  return value;
}

/**
 * Read one flag straight from the DB, bypassing the cache. THROWS on a read
 * error.
 *
 * The admin-page counterpart to getFlag, and the exact inverse of its posture —
 * same split as readPushEnabledUncached vs getPushEnabled. getFlag's job is to
 * keep the product running through a blip; this one's job is to tell an admin
 * the truth, and a toggle rendered from a fabricated default is a switch that
 * lies about its own position.
 *
 * Takes the caller's client (the Fastify-decorated one) so an admin read does
 * not open the lazy singleton this module keeps for the hot path.
 */
export async function readFlagUncached(
  supabase: SupabaseClient,
  key: FeatureFlagKey,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) throw error;
  const value = (data as { value?: unknown } | null)?.value;
  return typeof value === 'boolean' ? value : FEATURE_FLAG_FALLBACKS[key];
}

/**
 * Write one flag and record who did it.
 *
 * Order is load-bearing and copied deliberately from setPushEnabled: write the
 * row, invalidate the cache, THEN audit. The audit is last because it is the
 * step allowed to fail the request, and this write is cheaply reversible — the
 * caller reverts to `before` when AdminAuditError propagates (see the
 * compensation contract in admin-audit.service.ts). Cache invalidation sits in
 * the middle so a request that ends in a 500 still leaves Redis agreeing with
 * whatever ended up in the DB.
 *
 * Throws on a DB failure and on an audit failure. The route owns the revert.
 */
export async function setFlag(
  key: FeatureFlagKey,
  value: boolean,
  supabase: SupabaseClient,
  adminLineId: string,
): Promise<void> {
  const { data: prior, error: readErr } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (readErr) throw readErr;
  const priorValue = (prior as { value?: unknown } | null)?.value;
  const before = typeof priorValue === 'boolean' ? priorValue : FEATURE_FLAG_FALLBACKS[key];

  const { error } = await supabase.from('system_settings').upsert(
    {
      key,
      value,
      updated_by: adminLineId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' },
  );
  if (error) throw error;

  await invalidateFlagCache(key);

  await requireAdminAction({
    supabase,
    adminLineId,
    // One action verb for every flag, with the key in target_id — so "what has
    // been switched recently" is a single indexed prefix query rather than six
    // action strings someone has to know to look for.
    action: 'setting_flag',
    targetType: 'setting',
    targetId: key,
    before: { [key]: before },
    after: { [key]: value },
  });
}

/**
 * Drop one cached flag so the next read re-derives from the DB.
 *
 * Exported because the route's compensating revert needs it too: after writing
 * the old value back it must not leave the cache holding the value the failed
 * request tried to set. Never throws — a failed DELETE costs at most the 60 s
 * the TTL already allows.
 */
export async function invalidateFlagCache(key: string): Promise<void> {
  try {
    await cache().del(cacheKey(key));
  } catch (err) {
    console.warn(`[flags] cache invalidation failed for ${key} (TTL will expire it):`, err);
  }
}

/** Release the lazy Redis connection. Mirrors closePushFlag(). */
export async function closeFeatureFlags(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
