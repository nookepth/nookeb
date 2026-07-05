import type { SupabaseClient } from '@supabase/supabase-js';
import type { SpaceRecord, SpaceRole, UserRecord } from '@nookeb/shared';

/** Postgres unique_violation — races on the unique indexes from migration 016. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Find or create the shared team space for a LINE group.
 * The first member to interact becomes the owner; everyone else joins as member.
 *
 * Race-safe (FIX #4): webhook events fan out concurrently, so two first-messages
 * can both pass the find and both INSERT. The unique index on line_group_id
 * (migration 016) rejects the loser with 23505 — treated as "someone else just
 * created it": re-select and join that space instead of failing the event.
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
    if (createErr) {
      if (createErr.code !== PG_UNIQUE_VIOLATION) throw createErr;
      // Lost the creation race — use the space the winner just inserted.
      const { data: raced, error: racedErr } = await supabase
        .from('spaces')
        .select('*')
        .eq('line_group_id', lineGroupId)
        .eq('type', 'team')
        .maybeSingle();
      if (racedErr) throw racedErr;
      if (!raced) throw createErr; // 23505 but no row — genuinely unexpected
      space = raced as SpaceRecord;
      await addMember(supabase, space.id, creator.id, 'member');
      return space;
    }
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
  // Concurrent addMember calls can both pass the existence check; the composite
  // PK rejects the loser — already a member, which is exactly what we wanted.
  if (error && error.code !== PG_UNIQUE_VIOLATION) throw error;
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
