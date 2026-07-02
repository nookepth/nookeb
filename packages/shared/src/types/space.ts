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
}

export function toSpaceDto(s: SpaceRecord, role?: SpaceRole): SpaceDto {
  return { id: s.id, name: s.name, type: s.type, ...(role ? { role } : {}) };
}

export interface SpaceMemberDto {
  userId: string;
  role: SpaceRole;
  displayName: string | null;
  pictureUrl: string | null;
  joinedAt: string;
}
