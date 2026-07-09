import type { SupabaseClient } from '@supabase/supabase-js';
import type { DiaryEntryRecord, DiaryNotificationSettingsDto } from '@nookeb/shared';

/**
 * "ไดอารี่ 365 วัน" data access (migration 028). Diary entries are isolated
 * from the files table (own template rendering, one-per-day rule, never shown
 * in the locker). All reads/writes here filter soft-deleted rows; rows are
 * soft-deleted only (rule 6) and their R2 objects are purged by the daily
 * purge job (see purge.service).
 */

const PG_UNIQUE_VIOLATION = '23505';

// Bangkok is UTC+7 with no DST, so a fixed offset is exact — no tz library needed.
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Bangkok calendar day ('YYYY-MM-DD') for an instant (default: now). */
export function bangkokDateString(at: Date = new Date()): string {
  return new Date(at.getTime() + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

/** The Bangkok calendar day immediately before `date` ('YYYY-MM-DD'). */
function previousDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** R2 key for a diary photo — user-scoped (diary is personal-space only). */
export function buildDiaryImageKey(
  userId: string,
  entryDate: string,
  entryId: string,
  ext: string,
): string {
  const year = entryDate.slice(0, 4);
  return `diary/${userId}/${year}/${entryDate}_${entryId}.${ext}`;
}

export function buildDiaryThumbnailKey(userId: string, entryDate: string, entryId: string): string {
  const year = entryDate.slice(0, 4);
  return `diary/${userId}/${year}/thumb_${entryDate}_${entryId}.webp`;
}

/** Live entry for a user's calendar day, or null. */
export async function getEntryByDate(
  supabase: SupabaseClient,
  userId: string,
  entryDate: string,
): Promise<DiaryEntryRecord | null> {
  const { data, error } = await supabase
    .from('diary_entries')
    .select('*')
    .eq('user_id', userId)
    .eq('entry_date', entryDate)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  return (data as DiaryEntryRecord | null) ?? null;
}

/** Live entry by id, ownership enforced. */
export async function getEntryById(
  supabase: SupabaseClient,
  userId: string,
  entryId: string,
): Promise<DiaryEntryRecord | null> {
  const { data, error } = await supabase
    .from('diary_entries')
    .select('*')
    .eq('id', entryId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  return (data as DiaryEntryRecord | null) ?? null;
}

/**
 * Worker retry dedup: the live entry a LINE message already created, if any
 * (mirrors findLiveFileByLineMessageId).
 */
export async function getEntryByLineMessageId(
  supabase: SupabaseClient,
  lineMessageId: string,
): Promise<DiaryEntryRecord | null> {
  const { data, error } = await supabase
    .from('diary_entries')
    .select('*')
    .eq('line_message_id', lineMessageId)
    .is('deleted_at', null)
    .limit(1);
  if (error) throw error;
  return (data as DiaryEntryRecord[] | null)?.[0] ?? null;
}

/** Count of live entries — feeds day_number ("วันที่ X/365") and the streak header. */
export async function countEntries(supabase: SupabaseClient, userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('diary_entries')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('deleted_at', null);
  if (error) throw error;
  return count ?? 0;
}

export interface InsertDiaryEntryInput {
  id: string;
  userId: string;
  entryDate: string;
  imageKey: string;
  mimeType: string;
  fileSize: number;
  caption: string;
  dayNumber: number;
  lineMessageId: string;
}

/**
 * Insert an entry. The partial unique indexes (one live entry per user+day, one
 * per LINE message — migration 028) reject a duplicate INSERT with 23505; we
 * recover the winning row and return `deduped: true` so the caller can release
 * its quota reservation and clean up its R2 object instead of throwing.
 */
export async function insertEntry(
  supabase: SupabaseClient,
  input: InsertDiaryEntryInput,
): Promise<{ record: DiaryEntryRecord; deduped: boolean }> {
  const { data, error } = await supabase
    .from('diary_entries')
    .insert({
      id: input.id,
      user_id: input.userId,
      entry_date: input.entryDate,
      image_key: input.imageKey,
      mime_type: input.mimeType,
      file_size: input.fileSize,
      caption: input.caption,
      day_number: input.dayNumber,
      line_message_id: input.lineMessageId,
    })
    .select('*')
    .single();
  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      const existing =
        (await getEntryByLineMessageId(supabase, input.lineMessageId)) ??
        (await getEntryByDate(supabase, input.userId, input.entryDate));
      if (existing) return { record: existing, deduped: true };
    }
    throw error;
  }
  return { record: data as DiaryEntryRecord, deduped: false };
}

export async function setEntryThumbnail(
  supabase: SupabaseClient,
  entryId: string,
  thumbnailKey: string,
): Promise<void> {
  const { error } = await supabase
    .from('diary_entries')
    .update({ thumbnail_key: thumbnailKey, updated_at: new Date().toISOString() })
    .eq('id', entryId);
  if (error) throw error;
}

/** All live entries for a calendar year, oldest first (feeds the 365-day grid). */
export async function listEntriesByYear(
  supabase: SupabaseClient,
  userId: string,
  year: number,
): Promise<DiaryEntryRecord[]> {
  const { data, error } = await supabase
    .from('diary_entries')
    .select('*')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .gte('entry_date', `${year}-01-01`)
    .lte('entry_date', `${year}-12-31`)
    .order('entry_date', { ascending: true });
  if (error) throw error;
  return (data as DiaryEntryRecord[] | null) ?? [];
}

/**
 * Neighbouring entry dates for the page-flip viewer: the closest live entry
 * strictly before / after `entryDate` (null when at either end).
 */
export async function getAdjacentEntryDates(
  supabase: SupabaseClient,
  userId: string,
  entryDate: string,
): Promise<{ prev: string | null; next: string | null }> {
  const base = () =>
    supabase
      .from('diary_entries')
      .select('entry_date')
      .eq('user_id', userId)
      .is('deleted_at', null);
  const [prevRes, nextRes] = await Promise.all([
    base().lt('entry_date', entryDate).order('entry_date', { ascending: false }).limit(1),
    base().gt('entry_date', entryDate).order('entry_date', { ascending: true }).limit(1),
  ]);
  if (prevRes.error) throw prevRes.error;
  if (nextRes.error) throw nextRes.error;
  return {
    prev: (prevRes.data as { entry_date: string }[])?.[0]?.entry_date ?? null,
    next: (nextRes.data as { entry_date: string }[])?.[0]?.entry_date ?? null,
  };
}

export interface DiaryStreak {
  currentStreak: number;
  totalEntries: number;
  lastEntryDate: string | null;
}

/**
 * Current streak = consecutive Bangkok days with an entry, counting back from
 * today (or from yesterday when today has no entry yet — an unfinished today
 * doesn't break a streak). Dates are read newest-first; 366 covers a full leap
 * year, which bounds any possible streak.
 */
export async function getStreak(supabase: SupabaseClient, userId: string): Promise<DiaryStreak> {
  const { data, error, count } = await supabase
    .from('diary_entries')
    .select('entry_date', { count: 'exact' })
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('entry_date', { ascending: false })
    .limit(366);
  if (error) throw error;
  const dates = ((data as { entry_date: string }[] | null) ?? []).map((r) => r.entry_date);

  const today = bangkokDateString();
  let cursor = today;
  if (dates[0] !== today) cursor = previousDay(today); // today not written yet → anchor on yesterday
  let streak = 0;
  for (const d of dates) {
    if (d !== cursor) break;
    streak += 1;
    cursor = previousDay(cursor);
  }
  return {
    currentStreak: streak,
    totalEntries: count ?? dates.length,
    lastEntryDate: dates[0] ?? null,
  };
}

/**
 * Soft-delete an entry (rule 6). Gated on deleted_at still NULL so two
 * concurrent DELETEs can't double-refund (same pattern as DELETE /files/:id);
 * returns the row only when THIS call flipped it.
 */
export async function softDeleteEntry(
  supabase: SupabaseClient,
  userId: string,
  entryId: string,
): Promise<DiaryEntryRecord | null> {
  const { data, error } = await supabase
    .from('diary_entries')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', entryId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .select('*');
  if (error) throw error;
  return (data as DiaryEntryRecord[] | null)?.[0] ?? null;
}

const DEFAULT_NOTIFICATION: DiaryNotificationSettingsDto = {
  notifyTime: '20:00',
  isEnabled: true,
  timezone: 'Asia/Bangkok',
};

/** Reminder preferences, falling back to the defaults for users who never saved any. */
export async function getNotificationSettings(
  supabase: SupabaseClient,
  userId: string,
): Promise<DiaryNotificationSettingsDto> {
  const { data, error } = await supabase
    .from('diary_notification_settings')
    .select('notify_time, is_enabled, timezone')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ...DEFAULT_NOTIFICATION };
  const row = data as { notify_time: string; is_enabled: boolean; timezone: string };
  return {
    notifyTime: row.notify_time.slice(0, 5), // 'HH:MM:SS' → 'HH:MM'
    isEnabled: row.is_enabled,
    timezone: row.timezone,
  };
}

export async function upsertNotificationSettings(
  supabase: SupabaseClient,
  userId: string,
  settings: DiaryNotificationSettingsDto,
): Promise<void> {
  const { error } = await supabase.from('diary_notification_settings').upsert(
    {
      user_id: userId,
      notify_time: `${settings.notifyTime}:00`,
      is_enabled: settings.isEnabled,
      timezone: settings.timezone,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) throw error;
}
