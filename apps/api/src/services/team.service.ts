import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  JoinRequestResult,
  TeamInviteRecord,
  TeamJoinRequestDto,
  TeamJoinRequestRecord,
  TeamLineGroupRecord,
  TeamMemberDto,
  TeamRecord,
  TeamRole,
  UserRecord,
} from '@nookeb/shared';
import { addMember, ensureGroupSpace } from './space.service';

/**
 * Error with a stable machine code + HTTP status. team.router.ts maps these to
 * `{ success: false, error, code }` responses.
 */
export class TeamError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'TeamError';
  }
}

/** Thrown when an increment would push the team past its storage_limit. */
export class StorageQuotaError extends TeamError {
  constructor(
    public readonly teamId: string,
    message = 'Team storage quota exceeded',
  ) {
    super('TEAM_QUOTA_EXCEEDED', message, 413);
    this.name = 'StorageQuotaError';
  }
}

const notFound = (what: string) => new TeamError('NOT_FOUND', `${what} not found`, 404);
const forbidden = (msg: string) => new TeamError('FORBIDDEN', msg, 403);

/**
 * Best-effort: make `userId` a member of every group space bound to the team,
 * so the team's storage shows up in the dashboard switcher immediately (the
 * switcher lists SPACES, and a fresh team_members row alone isn't enough).
 * Never throws — a failure here must not block the join/bind it accompanies.
 */
async function joinTeamGroupSpaces(
  supabase: SupabaseClient,
  teamId: string,
  userId: string,
): Promise<void> {
  try {
    const { data: bindings } = await supabase
      .from('team_line_groups')
      .select('line_group_id')
      .eq('team_id', teamId);
    const groupIds = ((bindings as { line_group_id: string }[] | null) ?? []).map(
      (g) => g.line_group_id,
    );
    if (groupIds.length === 0) return;

    const { data: spaces } = await supabase
      .from('spaces')
      .select('id')
      .in('line_group_id', groupIds)
      .eq('type', 'team');
    for (const s of (spaces as { id: string }[] | null) ?? []) {
      await addMember(supabase, s.id, userId, 'member');
    }
  } catch {
    // best-effort — the team_members row is the source of truth
  }
}

/**
 * All space ids that belong to a team: spaces stamped with team_id (migration
 * 007 / bindLineGroup) UNION spaces reachable only through the LINE-group
 * binding (spaces created lazily by ensureGroupSpace never get team_id set).
 */
async function findTeamSpaceIds(supabase: SupabaseClient, teamId: string): Promise<string[]> {
  const ids = new Set<string>();

  const { data: direct, error: directErr } = await supabase
    .from('spaces')
    .select('id')
    .eq('team_id', teamId);
  if (directErr) throw directErr;
  for (const s of (direct as { id: string }[] | null) ?? []) ids.add(s.id);

  const { data: bindings, error: bindErr } = await supabase
    .from('team_line_groups')
    .select('line_group_id')
    .eq('team_id', teamId);
  if (bindErr) throw bindErr;
  const groupIds = ((bindings as { line_group_id: string }[] | null) ?? []).map(
    (g) => g.line_group_id,
  );
  if (groupIds.length > 0) {
    const { data: viaGroup, error: groupErr } = await supabase
      .from('spaces')
      .select('id')
      .in('line_group_id', groupIds)
      .eq('type', 'team');
    if (groupErr) throw groupErr;
    for (const s of (viaGroup as { id: string }[] | null) ?? []) ids.add(s.id);
  }

  return [...ids];
}

/**
 * Revoke space_members rows for the team's spaces — the counterpart of
 * joinTeamGroupSpaces / ensureGroupSpace. WITHOUT this, a user removed from a
 * team keeps full file access forever: /files auth checks space membership
 * only. Called on member removal / self-leave (one user) and on deleteTeam
 * (all users, userId omitted). Throws on failure — callers run it BEFORE the
 * team_members mutation so a failure leaves access fully intact (fail-closed)
 * and the operation can simply be retried.
 */
export async function revokeTeamSpaceMemberships(
  supabase: SupabaseClient,
  teamId: string,
  userId?: string,
): Promise<void> {
  const spaceIds = await findTeamSpaceIds(supabase, teamId);
  if (spaceIds.length === 0) return;

  let query = supabase.from('space_members').delete().in('space_id', spaceIds);
  if (userId) query = query.eq('user_id', userId);
  const { error } = await query;
  if (error) throw error;
}

/** Role lookup; null when not a member (or the team is soft-deleted). */
export async function getTeamRole(
  supabase: SupabaseClient,
  teamId: string,
  userId: string,
): Promise<TeamRole | null> {
  const { data, error } = await supabase
    .from('team_members')
    .select('role, teams!inner(deleted_at)')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .is('teams.deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  return ((data as { role: TeamRole } | null)?.role) ?? null;
}

async function requireRole(
  supabase: SupabaseClient,
  teamId: string,
  userId: string,
  allowed: TeamRole[],
  action: string,
): Promise<TeamRole> {
  const role = await getTeamRole(supabase, teamId, userId);
  if (!role) throw forbidden('Not a member of this team');
  if (!allowed.includes(role)) throw forbidden(`Only ${allowed.join('/')} can ${action}`);
  return role;
}

/** Create a team; creator becomes the owner member. */
export async function createTeam(
  supabase: SupabaseClient,
  userId: string,
  name: string,
): Promise<TeamRecord> {
  const { data, error } = await supabase
    .from('teams')
    .insert({ name, owner_id: userId })
    .select('*')
    .single();
  if (error) throw error;
  const team = data as TeamRecord;

  const { error: memberErr } = await supabase
    .from('team_members')
    .insert({ team_id: team.id, user_id: userId, role: 'owner' });
  if (memberErr) throw memberErr;

  return team;
}

export interface TeamDetail {
  team: TeamRecord;
  role: TeamRole;
  members: TeamMemberDto[];
  storage: { used: number; limit: number; percent: number };
}

/** Team + members + storage stats. Throws 403 if requester is not a member. */
export async function getTeam(
  supabase: SupabaseClient,
  teamId: string,
  requesterId: string,
): Promise<TeamDetail> {
  const role = await getTeamRole(supabase, teamId, requesterId);
  if (!role) throw forbidden('Not a member of this team');

  const { data: teamData, error: teamErr } = await supabase
    .from('teams')
    .select('*')
    .eq('id', teamId)
    .is('deleted_at', null)
    .maybeSingle();
  if (teamErr) throw teamErr;
  if (!teamData) throw notFound('Team');
  const team = teamData as TeamRecord;

  const { data: memberData, error: memberErr } = await supabase
    .from('team_members')
    .select('role, joined_at, users!inner(id, display_name, picture_url)')
    .eq('team_id', teamId)
    .order('joined_at', { ascending: true });
  if (memberErr) throw memberErr;

  const members: TeamMemberDto[] = (
    memberData as unknown as {
      role: TeamRole;
      joined_at: string;
      users: { id: string; display_name: string | null; picture_url: string | null };
    }[]
  ).map((m) => ({
    userId: m.users.id,
    role: m.role,
    displayName: m.users.display_name,
    pictureUrl: m.users.picture_url,
    joinedAt: m.joined_at,
  }));

  return {
    team,
    role,
    members,
    storage: {
      used: team.storage_used,
      limit: team.storage_limit,
      percent: team.storage_limit > 0 ? (team.storage_used / team.storage_limit) * 100 : 0,
    },
  };
}

export interface UserTeamSummary {
  team: TeamRecord;
  role: TeamRole;
  memberCount: number;
}

/** All (non-deleted) teams the user belongs to, with member counts. */
export async function listUserTeams(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserTeamSummary[]> {
  const { data, error } = await supabase
    .from('team_members')
    .select('role, teams!inner(*)')
    .eq('user_id', userId)
    .is('teams.deleted_at', null);
  if (error) throw error;

  const rows = data as unknown as { role: TeamRole; teams: TeamRecord }[];
  if (rows.length === 0) return [];

  const teamIds = rows.map((r) => r.teams.id);
  const { data: counts, error: countErr } = await supabase
    .from('team_members')
    .select('team_id')
    .in('team_id', teamIds);
  if (countErr) throw countErr;

  const countByTeam = new Map<string, number>();
  for (const row of counts as { team_id: string }[]) {
    countByTeam.set(row.team_id, (countByTeam.get(row.team_id) ?? 0) + 1);
  }

  return rows
    .map((r) => ({
      team: r.teams,
      role: r.role,
      memberCount: countByTeam.get(r.teams.id) ?? 1,
    }))
    .sort((a, b) => a.team.name.localeCompare(b.team.name));
}

/** Owner/admin mints a stateful 7-day invite (row in team_invites). */
export async function inviteMember(
  supabase: SupabaseClient,
  teamId: string,
  invitedBy: string,
): Promise<TeamInviteRecord> {
  await requireRole(supabase, teamId, invitedBy, ['owner', 'admin'], 'invite members');

  const { data, error } = await supabase
    .from('team_invites')
    .insert({ team_id: teamId, invited_by: invitedBy })
    .select('*')
    .single();
  if (error) throw error;
  return data as TeamInviteRecord;
}

/** Pending invites for the team management page. */
export async function listPendingInvites(
  supabase: SupabaseClient,
  teamId: string,
  requesterId: string,
): Promise<TeamInviteRecord[]> {
  // Invite TOKENS are owner/admin-only, matching the mint gate in inviteMember —
  // a plain member must never receive them (audit 2026-07-19). This is called
  // unconditionally inside the GET /:teamId detail fetch for EVERY member, so
  // return an empty list for non-managers rather than throwing (a throw would
  // 403 the whole team page for members). The UI only renders invites under its
  // own owner/admin gate, so members see no behaviour change.
  const role = await getTeamRole(supabase, teamId, requesterId);
  if (!role) throw forbidden('Not a member of this team');
  if (role !== 'owner' && role !== 'admin') return [];

  const { data, error } = await supabase
    .from('team_invites')
    .select('*')
    .eq('team_id', teamId)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data as TeamInviteRecord[];
}

/**
 * Validate an invite token and raise a join REQUEST (owner/admin must approve).
 * Does NOT add the user to team_members. The invite row stays 'pending' so one
 * link can gather requests from multiple people. Idempotent: an existing pending
 * request for the same (user, team) is reused — no duplicate row.
 */
export async function requestToJoin(
  supabase: SupabaseClient,
  token: string,
  userId: string,
): Promise<JoinRequestResult> {
  const { data, error } = await supabase
    .from('team_invites')
    .select('*, teams!inner(*)')
    .eq('token', token)
    .maybeSingle();
  if (error) throw error;
  const invite = data as (TeamInviteRecord & { teams: TeamRecord }) | null;

  if (!invite || invite.teams.deleted_at) {
    throw new TeamError('INVITE_INVALID', 'Invite link is invalid', 400);
  }
  if (invite.status !== 'pending' || new Date(invite.expires_at).getTime() < Date.now()) {
    throw new TeamError('INVITE_EXPIRED', 'Invite link has expired or was already used', 400);
  }

  // Already a member → nothing to request.
  const existingRole = await getTeamRole(supabase, invite.team_id, userId);
  if (existingRole) {
    throw new TeamError('ALREADY_MEMBER', 'You are already a member of this team', 409);
  }

  // Reuse an open request instead of inserting a duplicate.
  const { data: existingReq, error: existErr } = await supabase
    .from('team_join_requests')
    .select('id')
    .eq('team_id', invite.team_id)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .maybeSingle();
  if (existErr) throw existErr;

  if (!existingReq) {
    const { error: insErr } = await supabase
      .from('team_join_requests')
      .insert({ team_id: invite.team_id, user_id: userId, invite_id: invite.id, status: 'pending' });
    if (insErr) throw insErr;
  }

  return { status: 'pending_approval', teamName: invite.teams.name };
}

/** Owner/admin approves a pending request → the user becomes a member. */
export async function approveJoinRequest(
  supabase: SupabaseClient,
  requestId: string,
  reviewerId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('team_join_requests')
    .select('*')
    .eq('id', requestId)
    .maybeSingle();
  if (error) throw error;
  const req = data as TeamJoinRequestRecord | null;
  if (!req) throw notFound('Join request');

  await requireRole(supabase, req.team_id, reviewerId, ['owner', 'admin'], 'approve join requests');

  if (req.status !== 'pending') {
    throw new TeamError('REQUEST_NOT_PENDING', 'This request was already reviewed', 409);
  }

  // Add the member (idempotent if they somehow already joined).
  const existingRole = await getTeamRole(supabase, req.team_id, req.user_id);
  if (!existingRole) {
    const { error: joinErr } = await supabase
      .from('team_members')
      .insert({ team_id: req.team_id, user_id: req.user_id, role: 'member' });
    if (joinErr) throw joinErr;
  }

  // Surface the team in the new member's dashboard switcher right away.
  await joinTeamGroupSpaces(supabase, req.team_id, req.user_id);

  const { error: markErr } = await supabase
    .from('team_join_requests')
    .update({ status: 'approved', reviewed_by: reviewerId, reviewed_at: new Date().toISOString() })
    .eq('id', requestId)
    .eq('status', 'pending');
  if (markErr) throw markErr;
}

/** Owner/admin rejects a pending request (no member is added). */
export async function rejectJoinRequest(
  supabase: SupabaseClient,
  requestId: string,
  reviewerId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('team_join_requests')
    .select('team_id, status')
    .eq('id', requestId)
    .maybeSingle();
  if (error) throw error;
  const req = data as { team_id: string; status: TeamJoinRequestRecord['status'] } | null;
  if (!req) throw notFound('Join request');

  await requireRole(supabase, req.team_id, reviewerId, ['owner', 'admin'], 'reject join requests');

  if (req.status !== 'pending') {
    throw new TeamError('REQUEST_NOT_PENDING', 'This request was already reviewed', 409);
  }

  const { error: markErr } = await supabase
    .from('team_join_requests')
    .update({ status: 'rejected', reviewed_by: reviewerId, reviewed_at: new Date().toISOString() })
    .eq('id', requestId)
    .eq('status', 'pending');
  if (markErr) throw markErr;
}

/** Owner/admin lists the team's pending join requests with requester info. */
export async function listJoinRequests(
  supabase: SupabaseClient,
  teamId: string,
  requesterId: string,
): Promise<TeamJoinRequestDto[]> {
  await requireRole(supabase, teamId, requesterId, ['owner', 'admin'], 'view join requests');

  // Disambiguate the embed: team_join_requests has TWO FKs to users (user_id and
  // reviewed_by), so a bare users!inner(...) is ambiguous (PostgREST PGRST201).
  // The !user_id hint pins it to the requester.
  const { data, error } = await supabase
    .from('team_join_requests')
    .select('id, requested_at, users!user_id(id, display_name, picture_url)')
    .eq('team_id', teamId)
    .eq('status', 'pending')
    .order('requested_at', { ascending: true });
  if (error) throw error;

  return (
    data as unknown as {
      id: string;
      requested_at: string;
      users: { id: string; display_name: string | null; picture_url: string | null };
    }[]
  ).map((r) => ({
    id: r.id,
    userId: r.users.id,
    displayName: r.users.display_name,
    pictureUrl: r.users.picture_url,
    requestedAt: r.requested_at,
  }));
}

/** Owner/admin removes a member. The owner can never be removed. */
export async function removeMember(
  supabase: SupabaseClient,
  teamId: string,
  targetUserId: string,
  requesterId: string,
): Promise<void> {
  await requireRole(supabase, teamId, requesterId, ['owner', 'admin'], 'remove members');

  const targetRole = await getTeamRole(supabase, teamId, targetUserId);
  if (!targetRole) throw notFound('Member');
  if (targetRole === 'owner') {
    throw new TeamError('CANNOT_REMOVE_OWNER', 'The team owner cannot be removed', 400);
  }

  // Revoke space access FIRST (fail-closed): if this throws, the user is still
  // a team member and the removal can be retried; the reverse order could leave
  // an ex-member with permanent file access.
  await revokeTeamSpaceMemberships(supabase, teamId, targetUserId);

  const { error } = await supabase
    .from('team_members')
    .delete()
    .eq('team_id', teamId)
    .eq('user_id', targetUserId);
  if (error) throw error;
}

/** Owner-only soft delete; detaches all team files (rows keep their space_id). */
export async function deleteTeam(
  supabase: SupabaseClient,
  teamId: string,
  requesterId: string,
): Promise<void> {
  await requireRole(supabase, teamId, requesterId, ['owner'], 'delete the team');

  const { error: fileErr } = await supabase
    .from('files')
    .update({ team_id: null })
    .eq('team_id', teamId);
  if (fileErr) throw fileErr;

  // Revoke EVERYONE's access to the team's spaces before the soft delete —
  // otherwise ex-members keep file access via their space_members rows (the
  // /spaces switcher only hides the space; /files authorizes by membership).
  // Runs before the soft delete so a failure here leaves the team intact and
  // the delete retryable. (files.charged_team_id is NOT touched: it is the
  // quota-ledger record and must survive so later file deletes refund the
  // team's counter, never the uploader's personal quota — see FIX #3.)
  await revokeTeamSpaceMemberships(supabase, teamId);

  // Release the team's LINE-group bindings. Left behind, they outlive the
  // team forever: bindLineGroup answers GROUP_ALREADY_BOUND for any new team,
  // and unbindLineGroup requires a role on THIS (soon-deleted) team, which
  // getTeamRole filters out — so the group could never be bound again. Runs
  // before the soft delete so a failure leaves the team intact and retryable.
  const { error: unbindErr } = await supabase
    .from('team_line_groups')
    .delete()
    .eq('team_id', teamId);
  if (unbindErr) throw unbindErr;

  const { error } = await supabase
    .from('teams')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', teamId)
    .is('deleted_at', null);
  if (error) throw error;
}

/** Owner/admin binds a LINE group to the team (a group binds to ONE team).
 * Restricted to owner/admin to match unbindLineGroup (audit 2026-07-19): binding
 * is a structural action — it materializes a shared team space and pulls every
 * member into it — so it should not be triggerable by a plain member. The web
 * bind-form is gated to owner/admin to match. */
export async function bindLineGroup(
  supabase: SupabaseClient,
  teamId: string,
  lineGroupId: string,
  userId: string,
): Promise<TeamLineGroupRecord> {
  await requireRole(supabase, teamId, userId, ['owner', 'admin'], 'bind LINE groups');

  // line_group_id is UNIQUE — a group already bound elsewhere must be unbound first
  const { data: existing, error: findErr } = await supabase
    .from('team_line_groups')
    .select('*')
    .eq('line_group_id', lineGroupId)
    .maybeSingle();
  if (findErr) throw findErr;
  if (existing) {
    const bound = existing as TeamLineGroupRecord;
    if (bound.team_id === teamId) return bound; // idempotent re-bind
    throw new TeamError('GROUP_ALREADY_BOUND', 'This LINE group is already bound to another team', 409);
  }

  const { data, error } = await supabase
    .from('team_line_groups')
    .upsert(
      { team_id: teamId, line_group_id: lineGroupId, bound_by: userId },
      { onConflict: 'line_group_id' },
    )
    .select('*')
    .single();
  if (error) throw error;

  // Materialize the group space now (best-effort) so every current team member
  // gets a space membership immediately — otherwise the space wouldn't exist
  // until the first file arrives, and members couldn't see it in the switcher.
  try {
    const { data: binder } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .maybeSingle();
    if (binder) {
      await ensureGroupSpace(supabase, lineGroupId, binder as UserRecord);
      await joinTeamGroupSpaces(supabase, teamId, userId);
      // add all existing team members to the freshly created group space
      const { data: teamMembers } = await supabase
        .from('team_members')
        .select('user_id')
        .eq('team_id', teamId);
      const { data: space } = await supabase
        .from('spaces')
        .select('id')
        .eq('line_group_id', lineGroupId)
        .eq('type', 'team')
        .maybeSingle();
      const spaceId = (space as { id: string } | null)?.id;
      if (spaceId) {
        // Stamp the direct team_id link (migration 007) so /spaces can resolve
        // the team name by a simple join instead of the line_group_id path.
        await supabase.from('spaces').update({ team_id: teamId }).eq('id', spaceId);
        for (const m of (teamMembers as { user_id: string }[] | null) ?? []) {
          await addMember(supabase, spaceId, m.user_id, 'member');
        }
      }
    }
  } catch {
    // best-effort — the binding is the source of truth
  }

  return data as TeamLineGroupRecord;
}

/** Owner/admin unbinds a LINE group from the team. */
export async function unbindLineGroup(
  supabase: SupabaseClient,
  teamId: string,
  lineGroupId: string,
  userId: string,
): Promise<void> {
  await requireRole(supabase, teamId, userId, ['owner', 'admin'], 'unbind LINE groups');

  const { error } = await supabase
    .from('team_line_groups')
    .delete()
    .eq('team_id', teamId)
    .eq('line_group_id', lineGroupId);
  if (error) throw error;
}

/** LINE groups bound to the team (for the management page). */
export async function listLineGroups(
  supabase: SupabaseClient,
  teamId: string,
  requesterId: string,
): Promise<TeamLineGroupRecord[]> {
  const role = await getTeamRole(supabase, teamId, requesterId);
  if (!role) throw forbidden('Not a member of this team');

  const { data, error } = await supabase
    .from('team_line_groups')
    .select('*')
    .eq('team_id', teamId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data as TeamLineGroupRecord[];
}

/**
 * Atomically adjust team storage via the increment_team_storage RPC (migration
 * 005) — never read-modify-write (rule 8 applies to teams too).
 *
 * enforce=true (default): the RPC refuses an increment that would exceed
 * storage_limit and this throws StorageQuotaError — use it to RESERVE quota
 * BEFORE storing. enforce=false: unconditional (clamped at 0) — use it to
 * settle size drift after upload or to free space on delete.
 */
export async function incrementTeamStorage(
  supabase: SupabaseClient,
  teamId: string,
  bytes: number,
  opts: { enforce?: boolean } = {},
): Promise<number> {
  const { data, error } = await supabase.rpc('increment_team_storage', {
    p_team_id: teamId,
    p_delta: Math.round(bytes),
    p_enforce: opts.enforce ?? true,
  });
  if (error) {
    if (error.message?.includes('team_quota_exceeded')) {
      throw new StorageQuotaError(teamId);
    }
    throw error;
  }
  return data as number;
}

/** Team bound to a LINE group, or null. Used by the upload worker. */
export async function getTeamByLineGroup(
  supabase: SupabaseClient,
  lineGroupId: string,
): Promise<TeamRecord | null> {
  const { data, error } = await supabase
    .from('team_line_groups')
    .select('teams!inner(*)')
    .eq('line_group_id', lineGroupId)
    .is('teams.deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  return ((data as unknown as { teams: TeamRecord } | null)?.teams) ?? null;
}
