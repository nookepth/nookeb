export interface TagRecord {
  id: string;
  space_id: string;
  name: string;
  color: string;
}

export interface TagDto {
  id: string;
  spaceId: string;
  name: string;
  color: string;
}

export function toTagDto(t: TagRecord): TagDto {
  return {
    id: t.id,
    spaceId: t.space_id,
    name: t.name,
    color: t.color,
  };
}
