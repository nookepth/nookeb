import type { SupabaseClient } from '@supabase/supabase-js';
import type { FileRecord, LineSource, SpaceRecord, UserRecord } from '@nookeb/shared';
import { config } from '../config';

/** Find or create the user + personal space for a LINE user. */
export async function ensureUserAndSpace(
  supabase: SupabaseClient,
  lineUserId: string,
  displayName?: string,
  pictureUrl?: string,
): Promise<{ user: UserRecord; space: SpaceRecord }> {
  const { data: existing, error: findErr } = await supabase
    .from('users')
    .select('*')
    .eq('line_user_id', lineUserId)
    .maybeSingle();
  if (findErr) throw findErr;

  let user = existing as UserRecord | null;
  if (!user) {
    const { data: created, error: createErr } = await supabase
      .from('users')
      .insert({
        line_user_id: lineUserId,
        display_name: displayName ?? null,
        picture_url: pictureUrl ?? null,
        storage_limit: config.DEFAULT_STORAGE_LIMIT,
      })
      .select('*')
      .single();
    if (createErr) throw createErr;
    user = created as UserRecord;
  }

  const { data: memberRows, error: memberErr } = await supabase
    .from('space_members')
    .select('space_id, spaces!inner(*)')
    .eq('user_id', user.id)
    .eq('spaces.type', 'personal')
    .limit(1);
  if (memberErr) throw memberErr;

  const memberRow = memberRows?.[0] as { spaces: SpaceRecord } | undefined;
  if (memberRow) {
    return { user, space: memberRow.spaces };
  }

  const { data: space, error: spaceErr } = await supabase
    .from('spaces')
    .insert({ name: user.display_name ? `คลังของ ${user.display_name}` : 'My Space', owner_id: user.id, type: 'personal' })
    .select('*')
    .single();
  if (spaceErr) throw spaceErr;

  const { error: joinErr } = await supabase
    .from('space_members')
    .insert({ space_id: (space as SpaceRecord).id, user_id: user.id, role: 'owner' });
  if (joinErr) throw joinErr;

  return { user, space: space as SpaceRecord };
}

export interface CreateFileInput {
  id: string;
  spaceId: string;
  uploadedBy: string;
  originalName: string;
  mimeType: string;
  fileSize: number;
  extension: string | null;
  r2Key: string;
  lineMessageId: string | null;
  lineSource: LineSource | null;
  lineGroupId: string | null;
}

export async function createFileRecord(
  supabase: SupabaseClient,
  input: CreateFileInput,
): Promise<FileRecord> {
  const { data, error } = await supabase
    .from('files')
    .insert({
      id: input.id,
      space_id: input.spaceId,
      uploaded_by: input.uploadedBy,
      original_name: input.originalName,
      mime_type: input.mimeType,
      file_size: input.fileSize,
      extension: input.extension,
      r2_key: input.r2Key,
      line_message_id: input.lineMessageId,
      line_source: input.lineSource,
      line_group_id: input.lineGroupId,
      status: 'processing',
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as FileRecord;
}

export async function markFileReady(
  supabase: SupabaseClient,
  fileId: string,
  fileSize: number,
): Promise<void> {
  const { error } = await supabase
    .from('files')
    .update({ status: 'ready', file_size: fileSize, updated_at: new Date().toISOString() })
    .eq('id', fileId);
  if (error) throw error;
}

export async function markFileError(supabase: SupabaseClient, fileId: string): Promise<void> {
  const { error } = await supabase
    .from('files')
    .update({ status: 'error', updated_at: new Date().toISOString() })
    .eq('id', fileId);
  if (error) throw error;
}

/** Adjust a user's storage counter by `delta` bytes (positive to add, negative to free). */
export async function adjustStorageUsed(
  supabase: SupabaseClient,
  userId: string,
  delta: number,
): Promise<void> {
  // Read-modify-write is fine at MVP volume; move to an RPC for atomicity later.
  const { data, error } = await supabase.from('users').select('storage_used').eq('id', userId).single();
  if (error) throw error;
  const next = Math.max(0, (data.storage_used as number) + delta);
  const { error: updateErr } = await supabase
    .from('users')
    .update({ storage_used: next, updated_at: new Date().toISOString() })
    .eq('id', userId);
  if (updateErr) throw updateErr;
}

export function addStorageUsed(
  supabase: SupabaseClient,
  userId: string,
  bytes: number,
): Promise<void> {
  return adjustStorageUsed(supabase, userId, bytes);
}

export async function isSpaceMember(
  supabase: SupabaseClient,
  spaceId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('space_members')
    .select('user_id')
    .eq('space_id', spaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}
