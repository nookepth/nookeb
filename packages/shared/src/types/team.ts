export type TeamRole = 'owner' | 'admin' | 'member';

export type TeamInviteStatus = 'pending' | 'accepted' | 'expired' | 'pending_approval';

export type TeamJoinRequestStatus = 'pending' | 'approved' | 'rejected';

export interface TeamRecord {
  id: string;
  name: string;
  owner_id: string;
  storage_used: number;
  storage_limit: number;
  created_at: string;
  deleted_at: string | null;
}

export interface TeamMemberRecord {
  id: string;
  team_id: string;
  user_id: string;
  role: TeamRole;
  joined_at: string;
}

export interface TeamInviteRecord {
  id: string;
  team_id: string;
  invited_by: string | null;
  token: string;
  status: TeamInviteStatus;
  expires_at: string;
  created_at: string;
}

export interface TeamJoinRequestRecord {
  id: string;
  team_id: string;
  user_id: string;
  invite_id: string;
  status: TeamJoinRequestStatus;
  requested_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

export interface TeamLineGroupRecord {
  id: string;
  team_id: string;
  line_group_id: string;
  bound_by: string | null;
  created_at: string;
}

export interface TeamDto {
  id: string;
  name: string;
  ownerId: string;
  storageUsed: number;
  storageLimit: number;
  createdAt: string;
  /** the requesting user's role (set when listing/fetching) */
  role?: TeamRole;
  memberCount?: number;
}

export interface TeamMemberDto {
  userId: string;
  role: TeamRole;
  displayName: string | null;
  pictureUrl: string | null;
  joinedAt: string;
}

export interface TeamInviteDto {
  id: string;
  token: string;
  status: TeamInviteStatus;
  expiresAt: string;
  createdAt: string;
  invitedBy: string | null;
}

/** A pending request to join a team, shown to owners/admins for review. */
export interface TeamJoinRequestDto {
  id: string;
  userId: string;
  displayName: string | null;
  pictureUrl: string | null;
  requestedAt: string;
}

/** Response of POST /invite/:token/accept — a request was raised, not a join. */
export interface JoinRequestResult {
  status: 'pending_approval';
  teamName: string;
}

export interface TeamLineGroupDto {
  id: string;
  lineGroupId: string;
  boundBy: string | null;
  createdAt: string;
}

export function toTeamDto(t: TeamRecord, extra?: { role?: TeamRole; memberCount?: number }): TeamDto {
  return {
    id: t.id,
    name: t.name,
    ownerId: t.owner_id,
    storageUsed: t.storage_used,
    storageLimit: t.storage_limit,
    createdAt: t.created_at,
    ...(extra?.role ? { role: extra.role } : {}),
    ...(extra?.memberCount !== undefined ? { memberCount: extra.memberCount } : {}),
  };
}
