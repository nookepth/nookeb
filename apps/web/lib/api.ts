import type {
  FileDto,
  FileListResponse,
  FolderDto,
  JoinRequestResult,
  SpaceDto,
  SpaceMemberDto,
  TagDto,
  TeamDto,
  TeamInviteDto,
  TeamJoinRequestDto,
  TeamLineGroupDto,
  TeamMemberDto,
  UserDto,
} from '@nookeb/shared';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const TOKEN_KEY = 'nookeb_token';
const SPACE_KEY = 'nookeb_space_id';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setSession(token: string, defaultSpaceId: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(SPACE_KEY, defaultSpaceId);
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SPACE_KEY);
}

export function getSpaceId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(SPACE_KEY);
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 401) {
    clearSession();
    throw new ApiError(401, 'Unauthorized');
  }
  if (!res.ok) {
    throw new ApiError(res.status, `API error ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ListFilesOptions {
  page?: number;
  search?: string;
  folderId?: string;
  tagId?: string;
}

export function listFiles(spaceId: string, opts: ListFilesOptions = {}): Promise<FileListResponse> {
  const params = new URLSearchParams({ spaceId });
  if (opts.page) params.set('page', String(opts.page));
  if (opts.search) params.set('search', opts.search);
  if (opts.folderId) params.set('folderId', opts.folderId);
  if (opts.tagId) params.set('tagId', opts.tagId);
  return apiFetch<FileListResponse>(`/files?${params.toString()}`);
}

/** File detail incl. presigned inline `url` (expires 1 hour) — used for preview. */
export function getFile(fileId: string): Promise<FileDto & { url: string | null }> {
  return apiFetch(`/files/${fileId}`);
}

export function renameFile(fileId: string, displayName: string): Promise<FileDto> {
  return apiFetch<FileDto>(`/files/${fileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
}

export function moveFile(fileId: string, folderId: string | null): Promise<FileDto> {
  return apiFetch<FileDto>(`/files/${fileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderId }),
  });
}

export function deleteFile(fileId: string): Promise<void> {
  return apiFetch<void>(`/files/${fileId}`, { method: 'DELETE' });
}

export function listFolders(spaceId: string): Promise<{ folders: FolderDto[] }> {
  return apiFetch(`/folders?spaceId=${encodeURIComponent(spaceId)}`);
}

export function createFolder(
  spaceId: string,
  name: string,
  parentId?: string | null,
): Promise<FolderDto> {
  return apiFetch<FolderDto>(`/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spaceId, name, parentId: parentId ?? null }),
  });
}

export function deleteFolder(folderId: string): Promise<void> {
  return apiFetch<void>(`/folders/${folderId}`, { method: 'DELETE' });
}

export function listTags(spaceId: string): Promise<{ tags: TagDto[] }> {
  return apiFetch(`/tags?spaceId=${encodeURIComponent(spaceId)}`);
}

export function createTag(spaceId: string, name: string, color?: string): Promise<TagDto> {
  return apiFetch<TagDto>(`/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spaceId, name, ...(color ? { color } : {}) }),
  });
}

export function attachTag(fileId: string, tagId: string): Promise<void> {
  return apiFetch<void>(`/files/${fileId}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tagId }),
  });
}

export function detachTag(fileId: string, tagId: string): Promise<void> {
  return apiFetch<void>(`/files/${fileId}/tags/${tagId}`, { method: 'DELETE' });
}

export function listSpaces(): Promise<{ spaces: SpaceDto[] }> {
  return apiFetch(`/spaces`);
}

export function listMembers(spaceId: string): Promise<{ members: SpaceMemberDto[] }> {
  return apiFetch(`/spaces/${spaceId}/members`);
}

export interface UsageResponse {
  storageUsed: number;
  storageLimit: number;
  fileCount: number;
  byType: { type: string; count: number; bytes: number }[];
  spaces: { id: string; name: string; type: string; role: string; fileCount: number; bytes: number }[];
}

export function getUsage(): Promise<UsageResponse> {
  return apiFetch(`/me/usage`);
}

export interface ReferralStatusResponse {
  code: string;
  referralCount: number;
  currentTierGB: number;
  nextTierGB: number | null;
  neededForNext: number;
  progressPercent: number;
  /** the user this account redeemed a code from — null if never redeemed */
  referredById: string | null;
}

export function getReferralStatus(): Promise<ReferralStatusResponse> {
  return apiFetch(`/referral/status`);
}

export interface RedeemResponse {
  ok: boolean;
  /** Thai failure reason from the API when ok === false */
  message?: string;
}

/** Redeem a friend's referral code for the signed-in user (one-time). */
export function redeemReferralCode(code: string): Promise<RedeemResponse> {
  return apiFetch<RedeemResponse>(`/referral/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

export interface GoogleStatus {
  enabled: boolean;
  connected: boolean;
  email: string | null;
}

export function getGoogleStatus(): Promise<GoogleStatus> {
  return apiFetch(`/integrations/google/status`);
}

export function getGoogleAuthUrl(): Promise<{ url: string }> {
  return apiFetch(`/integrations/google/auth-url`);
}

export function disconnectGoogle(): Promise<void> {
  return apiFetch<void>(`/integrations/google`, { method: 'DELETE' });
}

export function exportToDrive(fileId: string): Promise<{ driveFileId: string; link: string }> {
  return apiFetch(`/files/${fileId}/export/drive`, { method: 'POST' });
}

export interface AdminUser {
  id: string;
  lineUserId: string;
  displayName: string | null;
  plan: string;
  storageUsed: number;
  storageLimit: number;
  fileCount: number;
  createdAt: string;
  isAdmin: boolean;
}

export interface AdminSpace {
  id: string;
  name: string;
  type: string;
  lineGroupId: string | null;
  memberCount: number;
  fileCount: number;
  bytes: number;
  createdAt: string;
}

export function listAdminUsers(): Promise<{ users: AdminUser[] }> {
  return apiFetch(`/admin/users`);
}

export function listAdminSpaces(): Promise<{ spaces: AdminSpace[] }> {
  return apiFetch(`/admin/spaces`);
}

export function setUserQuota(userId: string, storageLimit: number): Promise<{ id: string; storageLimit: number }> {
  return apiFetch(`/admin/users/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storageLimit }),
  });
}

export function getMe(): Promise<UserDto & { defaultSpaceId: string | null; isAdmin: boolean }> {
  return apiFetch(`/auth/me`);
}

export function loginWithLineCode(
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; user: UserDto; defaultSpaceId: string }> {
  return apiFetch(`/auth/line`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirectUri }),
  });
}

/* ============================================================
   Teams API (/api/teams) — envelope { success, data } / { success, error, code }
   ============================================================ */

async function teamFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}/api/teams${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 401) {
    clearSession();
    throw new ApiError(401, 'Unauthorized');
  }
  const body = (await res.json().catch(() => null)) as
    | { success: true; data: T }
    | { success: false; error: string; code: string }
    | null;
  if (!res.ok || !body || body.success !== true) {
    const message = body && 'error' in body ? body.error : `API error ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return body.data;
}

export interface TeamDetailResponse {
  team: TeamDto;
  members: TeamMemberDto[];
  storage: { used: number; limit: number; percent: number };
  invites: TeamInviteDto[];
  lineGroups: TeamLineGroupDto[];
}

export function listTeams(): Promise<TeamDto[]> {
  return teamFetch<TeamDto[]>(`/`);
}

export function createTeam(name: string): Promise<TeamDto> {
  return teamFetch<TeamDto>(`/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function getTeamDetail(teamId: string): Promise<TeamDetailResponse> {
  return teamFetch<TeamDetailResponse>(`/${teamId}`);
}

export function deleteTeam(teamId: string): Promise<{ deleted: boolean }> {
  return teamFetch(`/${teamId}`, { method: 'DELETE' });
}

export function createTeamInvite(
  teamId: string,
): Promise<{ token: string; url: string; expiresAt: string }> {
  return teamFetch(`/${teamId}/invite`, { method: 'POST' });
}

/** Raises a join request; an owner/admin must approve before the user is added. */
export function acceptTeamInvite(token: string): Promise<JoinRequestResult> {
  return teamFetch<JoinRequestResult>(`/invite/${encodeURIComponent(token)}/accept`, {
    method: 'POST',
  });
}

export function listTeamJoinRequests(teamId: string): Promise<TeamJoinRequestDto[]> {
  return teamFetch<TeamJoinRequestDto[]>(`/${teamId}/requests`);
}

export function approveTeamJoinRequest(
  teamId: string,
  requestId: string,
): Promise<{ approved: boolean }> {
  return teamFetch(`/${teamId}/requests/${requestId}/approve`, { method: 'POST' });
}

export function rejectTeamJoinRequest(
  teamId: string,
  requestId: string,
): Promise<{ rejected: boolean }> {
  return teamFetch(`/${teamId}/requests/${requestId}/reject`, { method: 'POST' });
}

export function removeTeamMember(teamId: string, userId: string): Promise<{ removed: boolean }> {
  return teamFetch(`/${teamId}/members/${userId}`, { method: 'DELETE' });
}

export function bindTeamGroup(teamId: string, lineGroupId: string): Promise<TeamLineGroupDto> {
  return teamFetch<TeamLineGroupDto>(`/${teamId}/groups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lineGroupId }),
  });
}

export function unbindTeamGroup(teamId: string, lineGroupId: string): Promise<{ unbound: boolean }> {
  return teamFetch(`/${teamId}/groups/${encodeURIComponent(lineGroupId)}`, { method: 'DELETE' });
}

/**
 * Two-step download: mint a one-time 60s token over an authenticated POST,
 * then navigate to the download URL carrying only that token (never the
 * session JWT). The API 302-redirects to a presigned R2 URL with
 * Content-Disposition: attachment, so the page itself never navigates away.
 */
export async function startDownload(fileId: string, mimeType?: string): Promise<void> {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isImage = typeof mimeType === 'string' && mimeType.startsWith('image/'); // FIX: download - scope the iOS direct-open path to images only

  if (isIOS && isImage) {
    // FIX: download - navigator.share()/blob fetch broke on iOS+LINE because the awaits severed the user-gesture chain (silent NotAllowedError → button did nothing). Skip share/blob entirely and just open the inline image URL so the user long-presses → "บันทึกรูปภาพ".
    const detail = await getFile(fileId); // FIX: download - inline presigned URL (no attachment disposition) so the image renders instead of downloading
    if (detail.url) {
      window.open(detail.url, '_blank'); // FIX: download - open a REAL url (never an empty tab), the only method that shows the image across iOS Safari AND LINE without a blank screen
      return;
    }
    // FIX: download - inline url missing (file not ready): fall through to the token download below
  }

  const { token } = await apiFetch<{ token: string }>(`/files/${fileId}/download-token`, {
    method: 'POST',
  });
  const downloadUrl = `${API_URL}/files/${fileId}/download?dl_token=${encodeURIComponent(token)}`;
  // FIX: download - iOS non-image keeps opening in a new tab; Android + desktop navigate in place to trigger the attachment download
  if (isIOS) {
    window.open(downloadUrl, '_blank');
  } else {
    window.location.assign(downloadUrl);
  }
}
