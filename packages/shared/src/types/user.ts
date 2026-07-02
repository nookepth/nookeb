export type Plan = 'free' | 'pro' | 'team';

export interface UserRecord {
  id: string;
  line_user_id: string;
  display_name: string | null;
  picture_url: string | null;
  email: string | null;
  plan: Plan;
  storage_used: number;
  storage_limit: number;
  created_at: string;
  updated_at: string;
}

export interface UserDto {
  id: string;
  displayName: string | null;
  pictureUrl: string | null;
  plan: Plan;
  storageUsed: number;
  storageLimit: number;
}

export function toUserDto(u: UserRecord): UserDto {
  return {
    id: u.id,
    displayName: u.display_name,
    pictureUrl: u.picture_url,
    plan: u.plan,
    storageUsed: u.storage_used,
    storageLimit: u.storage_limit,
  };
}
