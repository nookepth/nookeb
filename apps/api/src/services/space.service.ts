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

  // INVARIANT: for team-bound spaces (space.team_id set), LINE group membership
  // ≠ team membership. Only active team_members may receive space dashboard
  // access. A user removed from the team who is still in the LINE group keeps
  // uploading (their files are stored to the space, below), but must NOT regain
  // a space_members row — /files authorizes purely on space membership, so an
  // errant row would silently restore full access to every team file. The
  // gating lives in joinSenderToGroupSpace and is applied to every path that
  // joins the *sender* (not the fresh-create owner, whose space is never
  // team-bound yet — ensureGroupSpace never stamps team_id).
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
      await joinSenderToGroupSpace(supabase, space, creator);
      return space;
    }
    space = created as SpaceRecord;
    await addMember(supabase, space.id, creator.id, 'owner');
  } else {
    // Make sure the sender is a member of the group space (gated for team-bound
    // spaces — see the invariant above).
    await joinSenderToGroupSpace(supabase, space, creator);
  }

  return space;
}

/**
 * Join a LINE sender to an existing group space, enforcing the team-membership
 * invariant documented in ensureGroupSpace: for a team-bound space, only an
 * active member of that team gets a space_members row. Non-members are a no-op
 * here (their upload is still stored to the space by the worker) so they never
 * regain dashboard access after being removed from the team.
 */
async function joinSenderToGroupSpace(
  supabase: SupabaseClient,
  space: SpaceRecord,
  sender: UserRecord,
): Promise<void> {
  if (space.team_id) {
    const isMember = await isLineUserTeamMember(supabase, sender.line_user_id, space.team_id);
    if (!isMember) return; // ex-member (or never a member) — store, but no access
  }
  await addMember(supabase, space.id, sender.id, 'member');
}

/**
 * Is the given LINE user an active member of the team? Single round-trip:
 * team_members INNER JOIN users on line_user_id. Returns false when the LINE
 * user has no nookeb account yet (the inner join yields no row) — never throws
 * for that case.
 */
export async function isLineUserTeamMember(
  supabase: SupabaseClient,
  lineUserId: string,
  teamId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('team_members')
    .select('user_id, users!inner(line_user_id)')
    .eq('team_id', teamId)
    .eq('users.line_user_id', lineUserId)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
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
