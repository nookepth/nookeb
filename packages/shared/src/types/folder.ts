export interface FolderRecord {
  id: string;
  space_id: string;
  parent_id: string | null;
  name: string;
  created_by: string | null;
  created_at: string;
}

export interface FolderDto {
  id: string;
  spaceId: string;
  parentId: string | null;
  name: string;
  createdAt: string;
}

export function toFolderDto(f: FolderRecord): FolderDto {
  return {
    id: f.id,
    spaceId: f.space_id,
    parentId: f.parent_id,
    name: f.name,
    createdAt: f.created_at,
  };
}
