import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Per-group settings for LINE group/room chats. Currently a single toggle:
 * `notify_on_save` — whether the bot replies "บันทึกแล้วน้า ✓" after storing an
 * uploaded file in the group (migration 021).
 *
 * The setting is read on EVERY group upload (in upload-queue `flush`), so we keep a
 * tiny in-memory cache to avoid a DB round-trip per file. Cache characteristics:
 *   • Scope   — module-level Map, per API instance (same single-instance caveat as
 *               the upload debounce queue; a multi-instance deploy would let each
 *               instance hold its own copy for up to the TTL).
 *   • TTL     — 5 minutes. A stale entry only means the toggle takes at most 5 min
 *               to take effect on a different instance; on THIS instance the change
 *               is reflected immediately (setGroupNotifySetting primes the cache).
 *   • Key     — the LINE group id (or room id). Values are the effective boolean.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  value: boolean;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Effective "notify on save" setting for a group (default TRUE).
 *
 * Serves from the in-memory cache when fresh; otherwise reads the row and caches
 * the result for {@link CACHE_TTL_MS}. Fails OPEN: a null/empty group id or ANY DB
 * error resolves to `true` so an upload confirmation is never silently swallowed by
 * an infrastructure problem (and the caller — a file upload — is never broken).
 */
export async function getGroupNotifySetting(
  supabase: SupabaseClient,
  groupId: string | null | undefined,
): Promise<boolean> {
  if (!groupId) return true;

  const cached = cache.get(groupId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const { data, error } = await supabase
      .from('group_notify_settings')
      .select('notify_on_save')
      .eq('line_group_id', groupId)
      .maybeSingle();
    if (error) throw error;
    // No row → group has never changed the setting → default ON.
    const value = (data as { notify_on_save: boolean } | null)?.notify_on_save ?? true;
    cache.set(groupId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch {
    // Fail open — never let a settings lookup break/mute a real upload.
    return true;
  }
}

/**
 * Persist a group's "notify on save" toggle and immediately prime the in-memory
 * cache so the change takes effect on this instance without waiting for the TTL.
 * Upserts on the group id (one row per group). Throws on DB error — the command
 * handler catches it to reply with an apology rather than confirming falsely.
 */
export async function setGroupNotifySetting(
  supabase: SupabaseClient,
  groupId: string,
  enabled: boolean,
  updatedBy: string,
): Promise<void> {
  const { error } = await supabase.from('group_notify_settings').upsert(
    {
      line_group_id: groupId,
      notify_on_save: enabled,
      updated_by: updatedBy,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'line_group_id' },
  );
  if (error) throw error;

  // Reflect the change locally right away (don't wait for the TTL to expire).
  cache.set(groupId, { value: enabled, expiresAt: Date.now() + CACHE_TTL_MS });
}
