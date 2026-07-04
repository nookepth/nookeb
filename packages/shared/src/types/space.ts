export type SpaceType = 'personal' | 'team';

export type SpaceRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface SpaceRecord {
  id: string;
  name: string;
  owner_id: string | null;
  type: SpaceType;
  line_group_id: string | null;
  created_at: string;
}

export interface SpaceDto {
  id: string;
  name: string;
  type: SpaceType;
  /** the requesting user's role in this space (set by the API when listing) */
  role?: SpaceRole;
  /**
   * For team spaces: the linked team's display name (resolved via the space's
   * line_group_id → team_line_groups → teams). Null when the space isn't bound
   * to a team. The dashboard prefers this over the raw space name.
   */
  teamName?: string | null;
}

export function toSpaceDto(s: SpaceRecord, role?: SpaceRole, teamName?: string | null): SpaceDto {
  return {
    id: s.id,
    name: s.name,
    type: s.type,
    ...(role ? { role } : {}),
    ...(teamName ? { teamName } : {}),
  };
}

export interface SpaceMemberDto {
  userId: string;
  role: SpaceRole;
  displayName: string | null;
  pictureUrl: string | null;
  joinedAt: string;
}
