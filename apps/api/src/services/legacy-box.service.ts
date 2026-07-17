import type { SupabaseClient } from '@supabase/supabase-js';
import type { LegacyBoxRecord, LegacyBoxPhotoRecord, LegacyBoxDto, LegacyBoxThemeId } from '@nookeb/shared';
import { isThemeId, DEFAULT_THEME } from '@nookeb/shared';
import { config } from '../config';

/**
 * กล่องของขวัญ (Legacy Box) — data access for legacy_boxes / legacy_box_photos
 * (migration 033). Web-only feature; nothing in the LINE webhook or worker
 * writes here. R2 keys live under their own prefix, outside the space model.
 */

export function buildLegacyBoxPhotoKey(userId: string, boxId: string, photoId: string): string {
  return `legacy-box/${userId}/${boxId}/${photoId}.webp`;
}

export function legacyBoxShareUrl(slug: string): string {
  return `${config.WEB_URL}/box/${slug}`;
}

/** Coerce a stored theme string to a known theme id (schema drift safety). */
export function themeIdOf(box: Pick<LegacyBoxRecord, 'theme'>): LegacyBoxThemeId {
  return isThemeId(box.theme) ? box.theme : DEFAULT_THEME;
}

export async function countLiveBoxes(supabase: SupabaseClient, userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('legacy_boxes')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('deleted_at', null);
  if (error) throw error;
  return count ?? 0;
}

export async function insertBox(
  supabase: SupabaseClient,
  input: { id: string; userId: string; title: string; message: string; theme: LegacyBoxThemeId; totalBytes: number },
): Promise<LegacyBoxRecord> {
  // slug comes from the DB default (gen_random_bytes) — never generated app-side.
  const { data, error } = await supabase
    .from('legacy_boxes')
    .insert({
      id: input.id,
      user_id: input.userId,
      title: input.title,
      message: input.message,
      theme: input.theme,
      total_bytes: input.totalBytes,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as LegacyBoxRecord;
}

export async function insertPhotos(
  supabase: SupabaseClient,
  rows: { box_id: string; r2_key: string; mime_type: string; file_size: number; sort_order: number }[],
): Promise<void> {
  const { error } = await supabase.from('legacy_box_photos').insert(rows);
  if (error) throw error;
}

/** Creation-failure rollback ONLY — a published box is never hard-deleted. */
export async function deleteBoxRow(supabase: SupabaseClient, boxId: string): Promise<void> {
  const { error } = await supabase.from('legacy_boxes').delete().eq('id', boxId);
  if (error) throw error;
}

/** A live box owned by the caller (ownership check for delete/reorder). */
export async function getOwnedBox(
  supabase: SupabaseClient,
  userId: string,
  boxId: string,
): Promise<LegacyBoxRecord | null> {
  const { data, error } = await supabase
    .from('legacy_boxes')
    .select('*')
    .eq('id', boxId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  return (data as LegacyBoxRecord | null) ?? null;
}

/** PUBLIC lookup — live boxes only. The slug itself is the credential. */
export async function getBoxBySlug(
  supabase: SupabaseClient,
  slug: string,
): Promise<LegacyBoxRecord | null> {
  const { data, error } = await supabase
    .from('legacy_boxes')
    .select('*')
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  return (data as LegacyBoxRecord | null) ?? null;
}

export async function listBoxes(
  supabase: SupabaseClient,
  userId: string,
): Promise<LegacyBoxRecord[]> {
  const { data, error } = await supabase
    .from('legacy_boxes')
    .select('*')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as LegacyBoxRecord[];
}

export async function listPhotos(
  supabase: SupabaseClient,
  boxId: string,
): Promise<LegacyBoxPhotoRecord[]> {
  const { data, error } = await supabase
    .from('legacy_box_photos')
    .select('*')
    .eq('box_id', boxId)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data ?? []) as LegacyBoxPhotoRecord[];
}

/** Photos for many boxes in one query (list page: counts + cover per box). */
export async function listPhotosForBoxes(
  supabase: SupabaseClient,
  boxIds: string[],
): Promise<Map<string, LegacyBoxPhotoRecord[]>> {
  const byBox = new Map<string, LegacyBoxPhotoRecord[]>();
  if (boxIds.length === 0) return byBox;
  const { data, error } = await supabase
    .from('legacy_box_photos')
    .select('*')
    .in('box_id', boxIds)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  for (const row of (data ?? []) as LegacyBoxPhotoRecord[]) {
    const list = byBox.get(row.box_id);
    if (list) list.push(row);
    else byBox.set(row.box_id, [row]);
  }
  return byBox;
}

/**
 * Soft delete with the affected-rows guard (same pattern as trash restore):
 * the caller refunds total_bytes only when this returns true, so a lost race
 * (double-tap delete) can never refund twice.
 */
export async function softDeleteBox(
  supabase: SupabaseClient,
  userId: string,
  boxId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('legacy_boxes')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', boxId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .select('id');
  if (error) throw error;
  return (data ?? []).length > 0;
}

export function toLegacyBoxDto(
  box: LegacyBoxRecord,
  photoCount: number,
  coverUrl: string | null,
): LegacyBoxDto {
  return {
    id: box.id,
    slug: box.slug,
    shareUrl: legacyBoxShareUrl(box.slug),
    title: box.title,
    message: box.message,
    theme: themeIdOf(box),
    photoCount,
    totalBytes: Number(box.total_bytes),
    viewCount: box.view_count,
    createdAt: box.created_at,
    coverUrl,
  };
}
