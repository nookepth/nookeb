import type { SupabaseClient } from '@supabase/supabase-js';
import type { SpaceRecord, SpaceRole, UserRecord } from '@nookeb/shared';

/**
 * Find or create the shared team space for a LINE group.
 * The first member to interact becomes the owner; everyone else joins as member.
 */
export async function ensureGroupSpace(
  supabase: SupabaseClient,
  lineGroupId: string,
  creator: UserRecord,
): Promise<SpaceRecord> {
  const { data: existing, error: findErr } = await supabase
    .from('spaces')
    .select('*')
    .eq('line_group_id', lineGroupId)
    .eq('type', 'team')
    .maybeSingle();
  if (findErr) throw findErr;

  let space = existing as SpaceRecord | null;
  if (!space) {
    const { data: created, error: createErr } = await supabase
      .from('spaces')
      .insert({
        name: 'คลังกลุ่ม',
        owner_id: creator.id,
        type: 'team',
        line_group_id: lineGroupId,
      })
      .select('*')
      .single();
    if (createErr) throw createErr;
    space = created as SpaceRecord;
    await addMember(supabase, space.id, creator.id, 'owner');
  } else {
    // Make sure the sender is a member of the group space
    await addMember(supabase, space.id, creator.id, 'member');
  }

  return space;
}

/** Add a member to a space. No-op if already a member (never downgrades role). */
export async function addMember(
  supabase: SupabaseClient,
  spaceId: string,
  userId: string,
  role: SpaceRole,
): Promise<void> {
  const { data: existing, error: findErr } = await supabase
    .from('space_members')
    .select('user_id')
    .eq('space_id', spaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (findErr) throw findErr;
  if (existing) return;

  const { error } = await supabase
    .from('space_members')
    .insert({ space_id: spaceId, user_id: userId, role });
  if (error) throw error;
}

export async function getMemberRole(
  supabase: SupabaseClient,
  spaceId: string,
  userId: string,
): Promise<SpaceRole | null> {
  const { data, error } = await supabase
    .from('space_members')
    .select('role')
    .eq('space_id', spaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data?.role as SpaceRole | undefined) ?? null;
}
