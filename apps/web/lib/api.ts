import type {
  DiaryEntryDto,
  DiaryNotificationSettingsDto,
  DiaryStreakResponse,
  DiaryTodayStatusResponse,
  FileDto,
  FileListResponse,
  FolderDto,
  TrashListResponse,
  LegacyBoxListResponse,
  LegacyBoxOpenResponse,
  JoinRequestResult,
  SpaceDto,
  SpaceMemberDto,
  TagDto,
  TeamDto,
  TeamInviteDto,
  TeamJoinRequestDto,
  TeamLineGroupDto,
  TeamMemberDto,
  TaskDto,
  GroupMemberDto,
  UserDto,
} from '@nookeb/shared';

// All API calls go through the same-origin /api-proxy rewrite (next.config.mjs
// → the deployed API). Same-origin is what lets the HttpOnly SameSite=Lax
// session cookie flow in Safari and the LINE in-app browser, which block
// cross-site cookies.
export const API_URL = '/api-proxy';

// FIX #7: the JWT itself lives in an HttpOnly cookie set by POST /auth/line —
// client-side JS can never read it. localStorage keeps only a non-sensitive
// "probably logged in" hint (so pages can show the login screen without a
// round trip) and the last-used space id. A stale hint costs one 401, which
// clears it. LEGACY_TOKEN_KEY scrubs the pre-cookie JWT out of localStorage.
const SESSION_HINT_KEY = 'nookeb_has_session';
const LEGACY_TOKEN_KEY = 'nookeb_token';
const SPACE_KEY = 'nookeb_space_id';

/** UX hint only — authorization is the HttpOnly cookie, never this flag. */
export function hasSession(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(SESSION_HINT_KEY) === '1';
}

export function setSession(defaultSpaceId: string): void {
  localStorage.setItem(SESSION_HINT_KEY, '1');
  localStorage.setItem(SPACE_KEY, defaultSpaceId);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_HINT_KEY);
  localStorage.removeItem(SPACE_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  // Best-effort server-side logout: clears the HttpOnly session cookie (which
  // JS cannot remove itself). Endpoint needs no auth, so this never loops.
  void fetch(`${API_URL}/auth/logout`, { method: 'POST' }).catch(() => {});
}

export function getSpaceId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(SPACE_KEY);
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  // Same-origin request — the browser attaches the session cookie itself;
  // no Authorization header, and nothing token-like for XSS to steal.
  const res = await fetch(`${API_URL}${path}`, init);
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
    /** Machine-readable error code from the API body (e.g. 'VAULT_LOCKED'). */
    public code?: string,
  ) {
    super(message);
  }
}

export interface ListFilesOptions {
  page?: number;
  limit?: number;
  search?: string;
  folderId?: string;
  tagId?: string;
  /** Type-tab group ('image' | 'doc' | 'video' | 'other'); omit for all types. */
  fileType?: string;
}

export function listFiles(spaceId: string, opts: ListFilesOptions = {}): Promise<FileListResponse> {
  const params = new URLSearchParams({ spaceId });
  if (opts.page) params.set('page', String(opts.page));
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.search) params.set('search', opts.search);
  if (opts.folderId) params.set('folderId', opts.folderId);
  if (opts.tagId) params.set('tagId', opts.tagId);
  if (opts.fileType) params.set('fileType', opts.fileType);
  return apiFetch<FileListResponse>(`/files?${params.toString()}`);
}

/** Aggregate counts for the dashboard stat chips — reflects ALL matching files,
 *  not just the current page. Counts are keyed by raw mime type; the client
 *  buckets them via `fileGroup`. */
export interface FileStatsResponse {
  total: number;
  byType: Record<string, number>;
  storageUsed: number;
}

export type FileStatsOptions = Pick<ListFilesOptions, 'search' | 'folderId' | 'tagId'>;

export function getFileStats(spaceId: string, opts: FileStatsOptions = {}): Promise<FileStatsResponse> {
  const params = new URLSearchParams({ spaceId });
  if (opts.search) params.set('search', opts.search);
  if (opts.folderId) params.set('folderId', opts.folderId);
  if (opts.tagId) params.set('tagId', opts.tagId);
  return apiFetch<FileStatsResponse>(`/files/stats?${params.toString()}`);
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

/* ============================================================
   ถังขยะ (Trash Bin) — routes/trash.ts, migration 032
   ============================================================ */

/**
 * Trash calls parse the error body (unlike apiFetch): restore's 409 carries a
 * user-facing Thai message + a machine `code` ('QUOTA_EXCEEDED' when the quota
 * blocks the restore) that the page needs to pick the right modal.
 */
async function trashFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}/trash${path}`, init);
  if (res.status === 401) {
    clearSession();
    throw new ApiError(401, 'Unauthorized');
  }
  const body = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: string; code?: string })
    | null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      typeof body?.error === 'string' ? body.error : `API error ${res.status}`,
      typeof body?.code === 'string' ? body.code : undefined,
    );
  }
  return body as T;
}

export function listTrash(page = 1, limit = 40): Promise<TrashListResponse> {
  return trashFetch(`?page=${page}&limit=${limit}`);
}

export interface RestoreTrashResponse {
  success: boolean;
  /** folder the file was restored into (null = space root) */
  folderId: string | null;
  folderName: string | null;
}

export function restoreTrashFile(fileId: string): Promise<RestoreTrashResponse> {
  return trashFetch(`/${fileId}/restore`, { method: 'POST' });
}

export function deleteTrashFilePermanently(fileId: string): Promise<{ success: boolean }> {
  return trashFetch(`/${fileId}/permanent`, { method: 'DELETE' });
}

export function emptyTrash(): Promise<{ success: boolean; count: number }> {
  return trashFetch(`/empty`, { method: 'POST' });
}

/* ============================================================
   File sharing (public links) — migration 027 / routes/share.ts
   ============================================================ */

export type ShareExpiresIn = '1h' | '24h' | '7d' | 'never';

export interface ShareDto {
  id: string;
  token: string;
  shareUrl: string;
  expiresAt: string | null;
  maxViews: number | null;
  viewCount: number;
  createdAt: string;
}

/** Public metadata + short-lived presigned URLs returned by GET /share/:token. */
export interface SharePreview {
  fileName: string;
  fileSize: number;
  mimeType: string;
  previewUrl: string;
  downloadUrl: string;
  expiresAt: string | null;
}

export function createShare(fileId: string, expiresIn: ShareExpiresIn): Promise<ShareDto> {
  return apiFetch<ShareDto>(`/files/${fileId}/shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn }),
  });
}

export function getShares(fileId: string): Promise<{ shares: ShareDto[] }> {
  return apiFetch(`/files/${fileId}/shares`);
}

export function deleteShare(fileId: string, shareId: string): Promise<void> {
  return apiFetch<void>(`/files/${fileId}/shares/${shareId}`, { method: 'DELETE' });
}

/**
 * Public share viewer fetch — used by the /share/[token] page for logged-out
 * visitors. Goes straight to the API (no auth needed); a 410 means the link
 * expired, a 404 means it never existed. Never routes through apiFetch, which
 * would clear the session on a 401 (irrelevant here) — the viewer has no session.
 */
export async function getSharePreview(token: string): Promise<SharePreview> {
  const res = await fetch(`${API_URL}/share/${encodeURIComponent(token)}`);
  if (res.status === 410) throw new ApiError(410, 'expired');
  if (!res.ok) throw new ApiError(res.status, `API error ${res.status}`);
  return (await res.json()) as SharePreview;
}

/**
 * Re-fetches a fresh presigned download URL on demand (public, no auth). The URL
 * from getSharePreview has a short TTL and 403s if the viewer waited before
 * clicking download; this mints a new 1-hour URL at click time. A 410 means the
 * link expired between page load and the click.
 */
export async function getShareDownloadUrl(
  token: string,
): Promise<{ downloadUrl: string; fileName: string }> {
  const res = await fetch(`${API_URL}/share/${encodeURIComponent(token)}/download`);
  if (res.status === 410) throw new ApiError(410, 'expired');
  if (!res.ok) throw new ApiError(res.status, `API error ${res.status}`);
  return (await res.json()) as { downloadUrl: string; fileName: string };
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

/* ---- Admin product analytics (migration 029 / usage_events) ---- */

export interface AdminOverview {
  totalUsers: number;
  newUsers7: number;
  newUsers30: number;
  dau: number;
  wau: number;
  mau: number;
  stickiness: number; // DAU/MAU %
  quotaBlocks7: number;
  retention: { cohort_size: number; d1_returned: number; d7_returned: number };
}

export interface AdminTimeseriesPoint {
  day: string;
  activeUsers: number;
  events: number;
  newUsers: number;
}

export interface AdminFeatureRow {
  eventType: string;
  uniqueUsers: number;
  eventCount: number;
}

export interface AdminFunnel {
  name: string;
  started: number;
  completed: number;
  completionRate: number | null;
}

export interface AdminPowerUser {
  userId: string;
  displayName: string | null;
  storageUsed: number;
  storageLimit: number;
  totalEvents: number;
  quotaBlocks: number;
  docxConverts: number;
  lastActive: string;
}

export function getAdminOverview(): Promise<AdminOverview> {
  return apiFetch(`/admin/overview`);
}

export function getAdminTimeseries(days = 30): Promise<{ days: number; series: AdminTimeseriesPoint[] }> {
  return apiFetch(`/admin/timeseries?days=${days}`);
}

export function getAdminFeatures(
  days = 30,
): Promise<{ days: number; features: AdminFeatureRow[]; funnels: AdminFunnel[] }> {
  return apiFetch(`/admin/features?days=${days}`);
}

export function getAdminPowerUsers(days = 30): Promise<{ days: number; users: AdminPowerUser[] }> {
  return apiFetch(`/admin/power-users?days=${days}`);
}

/* ---- Admin Pro-Interest dashboard (Task 3 / migration 042) ---- */

export interface AdminProInterestTask {
  featureId: string;
  viewEvents: number;
  viewUsers: number;
  clickEvents: number;
  clickUsers: number;
  dismissEvents: number;
  registeredUsers: number; // all-time deduped (pro_interest table)
  conversionRate: number | null; // clickUsers / viewUsers, %
}

export interface AdminProInterestGiftbox {
  feature: string; // 'audio' | 'video'
  taps: number;
}

export interface AdminProInterestDaily {
  day: string;
  taskClicks: number;
  giftboxTaps: number;
}

export interface AdminProInterest {
  days: number;
  tasks: AdminProInterestTask[];
  giftbox: AdminProInterestGiftbox[];
  daily: AdminProInterestDaily[];
}

export function getAdminProInterest(days = 30): Promise<AdminProInterest> {
  return apiFetch(`/admin/pro-interest?days=${days}`);
}

/* ---- Admin Tasks dashboard (Task 3 / migration 042) ---- */

export interface AdminTasksDaily {
  day: string;
  single: number;
  multi: number;
  recurring: number;
}

export interface AdminTasks {
  days: number;
  totals: {
    totalCreated: number;
    byType: { single: number; multi: number; recurring: number };
    byStatus: { pending: number; inProgress: number; done: number; cancelled: number };
    completionRate: number | null; // done / completable (excludes recurring), %
    icsDownloads: number;
    markDoneCount: number; // per-assignee-item completions (not task-level done)
    avgCompleteSec: number | null;
  };
  daily: AdminTasksDaily[];
}

export function getAdminTasks(days = 30): Promise<AdminTasks> {
  return apiFetch(`/admin/tasks?days=${days}`);
}

/* ---- Admin Funnel Overview + retention cohorts (Task 3 / migration 042) ---- */

export type FunnelStage =
  | 'awareness'
  | 'consideration'
  | 'conversion'
  | 'activation'
  | 'referral'
  | 'retention';

export interface AdminFunnelStage {
  stage: FunnelStage;
  count: number;
}

export interface AdminRetentionCohort {
  week: string;
  size: number;
  d1: number;
  d7: number;
  d30: number;
}

export interface AdminFunnelOverview {
  days: number;
  funnel: AdminFunnelStage[];
  cohorts: AdminRetentionCohort[];
}

export function getAdminFunnel(days = 30): Promise<AdminFunnelOverview> {
  return apiFetch(`/admin/funnel?days=${days}`);
}

/* ---- Admin Feature Adoption (module level) (Task 3 / migration 042) ---- */

export type FeatureModule = 'storage' | 'vault' | 'diary' | 'gift_box' | 'tasks' | 'referral';

export interface AdminModuleAdoption {
  module: FeatureModule;
  users: number;
  pctOfActive: number | null;
}

export interface AdminFeatureErrorRate {
  feature: string; // 'convert' | 'vault_unlock'
  ok: number;
  fail: number;
  errorRate: number | null; // fail / (ok + fail), %
}

export interface AdminAdoption {
  days: number;
  activeUsers: number;
  avgDepth: number;
  modules: AdminModuleAdoption[];
  errorRates: AdminFeatureErrorRate[];
}

export function getAdminAdoption(days = 30): Promise<AdminAdoption> {
  return apiFetch(`/admin/adoption?days=${days}`);
}

/* ---- Admin Storage / Quota dashboard (Task 3 / migration 042) ---- */

export interface AdminStorageBucket {
  bucket: string; // '0-20' .. '100+'
  users: number;
}

export interface AdminStorageWarningDay {
  day: string;
  warn80: number;
  warn95: number;
  blocked: number;
}

export interface AdminStorage {
  days: number;
  histogram: AdminStorageBucket[];
  warningsDaily: AdminStorageWarningDay[];
}

export function getAdminStorage(days = 30): Promise<AdminStorage> {
  return apiFetch(`/admin/storage?days=${days}`);
}

/* ---- Admin Referral / Marketing dashboard (Task 3 / migration 042) ---- */

export interface AdminReferrer {
  userId: string;
  displayName: string | null;
  referralCode: string | null;
  referralCount: number;
}

export interface AdminReferral {
  days: number;
  funnel: {
    issuedCodes: number;
    entered: number;
    activated: number;
    activationRate: number | null; // activated / entered, %
  };
  topReferrers: AdminReferrer[];
}

export function getAdminReferral(days = 30): Promise<AdminReferral> {
  return apiFetch(`/admin/referral?days=${days}`);
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
   ไดอารี่ 365 วัน (My Diary) — routes/diary.ts, migration 028
   ============================================================ */

export interface DiaryEntriesResponse {
  entries: DiaryEntryDto[];
  year: number;
  total: number;
}

/** Single-entry detail incl. presigned full image + page-flip neighbours. */
export interface DiaryEntryDetail extends DiaryEntryDto {
  imageUrl: string;
  prevDate: string | null;
  nextDate: string | null;
}

export function listDiaryEntries(year?: number): Promise<DiaryEntriesResponse> {
  const qs = year ? `?year=${year}` : '';
  return apiFetch(`/diary/entries${qs}`);
}

export function getDiaryEntry(date: string): Promise<DiaryEntryDetail> {
  return apiFetch(`/diary/entry/${encodeURIComponent(date)}`);
}

export function getDiaryStreak(): Promise<DiaryStreakResponse> {
  return apiFetch(`/diary/streak`);
}

export function getDiaryTodayStatus(): Promise<DiaryTodayStatusResponse> {
  return apiFetch(`/diary/today-status`);
}

export function deleteDiaryEntry(entryId: string): Promise<void> {
  return apiFetch<void>(`/diary/entry/${entryId}`, { method: 'DELETE' });
}

export function updateDiaryNotification(settings: DiaryNotificationSettingsDto): Promise<void> {
  return apiFetch<void>(`/diary/notification`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      notify_time: settings.notifyTime,
      is_enabled: settings.isEnabled,
      timezone: settings.timezone,
    }),
  });
}

/* ============================================================
   ห้องนิรภัย (Vault) — routes/vault.ts, migration 031.
   Lock states arrive as 403 + code ('VAULT_LOCKED' /
   'VAULT_PREMIUM_REQUIRED'), NOT 401 — 401 from the vault means the whole
   LINE session is gone. A wrong PIN is 401 + code 'VAULT_PIN_INCORRECT'
   (must NOT clear the session hint), so vaultFetch parses the body before
   deciding what a 401 means.
   ============================================================ */

export interface VaultStatus {
  hasPin: boolean;
  isPremium: boolean;
  isUnlocked: boolean;
  expiresIn: number | null;
}

export interface VaultFileDto {
  id: string;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
}

export interface VaultListResponse {
  files: VaultFileDto[];
  total: number;
  page: number;
  limit: number;
}

/** Totals for the dashboard vault card. Only fetchable while unlocked. */
export interface VaultStats {
  fileCount: number;
  storageUsed: number;
  imageCount: number;
  videoCount: number;
  pdfCount: number;
}

export class VaultPinError extends ApiError {
  constructor(
    status: number,
    message: string,
    code: string | undefined,
    /** Wrong-PIN attempts left before lockout (undefined when locked out). */
    public attemptsRemaining?: number,
    /** Present when locked out (or when this attempt triggered the lockout). */
    public retryAfterSeconds?: number,
  ) {
    super(status, message, code);
  }
}

async function vaultFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}/vault${path}`, init);
  const body = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: string; code?: string })
    | null;

  if (res.ok) return body as T;

  const code = typeof body?.code === 'string' ? body.code : undefined;
  const message = typeof body?.error === 'string' ? body.error : `API error ${res.status}`;

  if (code === 'VAULT_PIN_INCORRECT' || code === 'VAULT_PIN_LOCKED_OUT') {
    throw new VaultPinError(
      res.status,
      message,
      code,
      typeof body?.attemptsRemaining === 'number' ? body.attemptsRemaining : undefined,
      typeof body?.retryAfterSeconds === 'number' ? body.retryAfterSeconds : undefined,
    );
  }
  if (res.status === 401) {
    // A codeless vault 401 means the LINE session itself is gone.
    clearSession();
    throw new ApiError(401, 'Unauthorized');
  }
  throw new ApiError(res.status, message, code);
}

export function getVaultStatus(): Promise<VaultStatus> {
  return vaultFetch(`/session-status`);
}

export function setupVaultPin(pin: string): Promise<{ success: boolean }> {
  return vaultFetch(`/setup-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
}

export function unlockVault(pin: string): Promise<{ success: boolean; expiresIn: number }> {
  return vaultFetch(`/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
}

export function lockVault(): Promise<{ success: boolean }> {
  return vaultFetch(`/lock`, { method: 'POST' });
}

export function listVaultFiles(page = 1, limit = 20): Promise<VaultListResponse> {
  return vaultFetch(`/files?page=${page}&limit=${limit}`);
}

/**
 * Vault totals for the dashboard card. Guarded server-side (premium + unlock),
 * so call it only when getVaultStatus() reports isUnlocked — a locked vault
 * throws 403 VAULT_LOCKED rather than leaking counts.
 */
export function getVaultStats(): Promise<VaultStats> {
  return vaultFetch(`/stats`);
}

export function deleteVaultFile(fileId: string, pin: string): Promise<{ success: boolean }> {
  return vaultFetch(`/files/${fileId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
}

/**
 * View URL for <img>/<video>/<iframe> — same-origin through /api-proxy, so the
 * browser attaches the session cookie itself. The API re-checks ownership +
 * unlock state on every request; there is deliberately NO download variant.
 */
export function vaultViewUrl(fileId: string): string {
  return `${API_URL}/vault/files/${fileId}/view`;
}

/**
 * Multipart upload with progress (XHR — fetch has no upload progress events).
 * Server re-validates type + size; the client-side checks are UX only.
 */
export function uploadVaultFile(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<VaultFileDto> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_URL}/vault/upload`);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error'));
    xhr.onload = () => {
      const body = xhr.response as (Record<string, unknown> & { error?: string; code?: string }) | null;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as unknown as VaultFileDto);
        return;
      }
      if (xhr.status === 401) clearSession();
      reject(
        new ApiError(
          xhr.status,
          typeof body?.error === 'string' ? body.error : `API error ${xhr.status}`,
          typeof body?.code === 'string' ? body.code : undefined,
        ),
      );
    };
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}

/* ============================================================
   กล่องของขวัญ (Legacy Box) — routes/legacy-box.ts, migration 033
   ============================================================ */

/**
 * Legacy-box calls parse the error body (like trashFetch): create's 409 carries
 * 'QUOTA_EXCEEDED', 429 carries 'BOX_LIMIT_REACHED' — the create flow switches
 * on the code to show the right message.
 */
async function boxFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}/legacy-box${path}`, init);
  if (res.status === 401) {
    clearSession();
    throw new ApiError(401, 'Unauthorized');
  }
  const body = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: string; code?: string })
    | null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      typeof body?.error === 'string' ? body.error : `API error ${res.status}`,
      typeof body?.code === 'string' ? body.code : undefined,
    );
  }
  return body as T;
}

export function listLegacyBoxes(): Promise<LegacyBoxListResponse> {
  return boxFetch(``);
}

export function deleteLegacyBox(boxId: string): Promise<{ success: boolean }> {
  return boxFetch(`/${boxId}`, { method: 'DELETE' });
}

export function reorderLegacyBoxPhotos(
  boxId: string,
  photoIds: string[],
): Promise<{ success: boolean }> {
  return boxFetch(`/${boxId}/reorder`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ photoIds }),
  });
}

export interface CreateLegacyBoxInput {
  title: string;
  message: string;
  theme: string;
  /** occasion id, or null when the creator skipped step 1 */
  occasion: string | null;
  /** chosen or custom closing line; null lets the server apply DEFAULT_TAGLINE */
  tagline: string | null;
  photos: File[];
  /**
   * Recorded voice message, or null. Held in memory by the recorder until this
   * submit — there is no pre-submit upload, so an abandoned draft leaves nothing
   * behind. The server re-validates the container and size and charges its bytes.
   */
  voice?: Blob | null;
}

export interface CreateLegacyBoxResponse {
  id: string;
  slug: string;
  shareUrl: string;
}

/**
 * Multipart create with upload progress (XHR — same pattern as the vault).
 * Server re-validates everything; client-side checks are UX only.
 */
export function createLegacyBox(
  input: CreateLegacyBoxInput,
  onProgress?: (percent: number) => void,
): Promise<CreateLegacyBoxResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_URL}/legacy-box`);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error'));
    xhr.onload = () => {
      const body = xhr.response as (Record<string, unknown> & { error?: string; code?: string }) | null;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as unknown as CreateLegacyBoxResponse);
        return;
      }
      if (xhr.status === 401) clearSession();
      reject(
        new ApiError(
          xhr.status,
          typeof body?.error === 'string' ? body.error : `API error ${xhr.status}`,
          typeof body?.code === 'string' ? body.code : undefined,
        ),
      );
    };
    const form = new FormData();
    form.append('title', input.title);
    form.append('message', input.message);
    form.append('theme', input.theme);
    // FormData has no null — omit the field entirely so the server's default
    // (null) applies, rather than sending the string "null".
    if (input.occasion) form.append('occasion', input.occasion);
    if (input.tagline) form.append('tagline', input.tagline);
    for (const photo of input.photos) form.append('photos', photo);
    // The filename is cosmetic — the server derives the real extension from the
    // clip's own container bytes, never from this or from the Blob's type.
    if (input.voice) form.append('voice', input.voice, 'voice');
    xhr.send(form);
  });
}

/**
 * Pro-tier demand test — records that someone tapped "แจ้งเตือนฉัน" on a locked
 * feature. Unauthenticated and anonymous (see routes/pro-interest.ts); never
 * routed through apiFetch, which would clear the session hint on 401.
 */
export async function postProInterest(feature: 'audio' | 'video'): Promise<void> {
  const res = await fetch(`${API_URL}/api/pro-interest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feature }),
  });
  if (!res.ok) throw new ApiError(res.status, `API error ${res.status}`);
}

/**
 * PUBLIC open-page fetch — used by /box/[slug] for recipients (no session).
 * Never routes through apiFetch, which would clear the session hint on 401.
 */
export async function getLegacyBoxOpen(
  slug: string,
  opts?: { preview?: boolean },
): Promise<LegacyBoxOpenResponse> {
  // preview=1 is the API's NON-COUNTING read. Used when re-reading a box the
  // recipient already opened (re-signing an expired voice URL), where ticking
  // the counter again would invent a view that never happened.
  const query = opts?.preview ? '?preview=1' : '';
  const res = await fetch(`${API_URL}/legacy-box/open/${encodeURIComponent(slug)}${query}`, {
    cache: 'no-store',
  });
  if (!res.ok) throw new ApiError(res.status, `API error ${res.status}`);
  return (await res.json()) as LegacyBoxOpenResponse;
}

/* ============================================================
   Teams API (/api/teams) — envelope { success, data } / { success, error, code }
   ============================================================ */

async function teamFetch<T>(path: string, init?: RequestInit): Promise<T> {
  // Same-origin — session cookie attached by the browser (see apiFetch).
  const res = await fetch(`${API_URL}/api/teams${path}`, init);
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
  const isImage = typeof mimeType === 'string' && mimeType.startsWith('image/');

  if (isIOS && isImage) {
    const detail = await getFile(fileId);
    if (detail.url) {
      window.location.href = detail.url;
      return;
    }
  }

  const { token } = await apiFetch<{ token: string }>(`/files/${fileId}/download-token`, {
    method: 'POST',
  });
  const downloadUrl = `${API_URL}/files/${fileId}/download?dl_token=${encodeURIComponent(token)}`;
  window.location.assign(downloadUrl);
}

// ---- ระบบตามงาน (Task Manager) — dashboard "งานของฉัน" ----

export interface MyTasksResponse {
  tasks: TaskDto[];
  viewerLineUid: string;
}

/** Every task the logged-in user created or is assigned to, across all groups. */
export function listMyTasks(): Promise<MyTasksResponse> {
  return apiFetch<MyTasksResponse>('/tasks/mine');
}

/** Full detail for one task (creator/assignee/group member only). */
export function getTask(taskId: string): Promise<{ task: TaskDto; viewerLineUid: string }> {
  return apiFetch(`/tasks/${taskId}`);
}

/**
 * Mark the viewer's own part of a task item done (rolls the item/task up).
 * Optional short note is stored against the viewer's assignee row.
 */
export function markTaskItemDone(
  taskId: string,
  itemId: string,
  note?: string,
): Promise<{ task: TaskDto; taskDone: boolean }> {
  return apiFetch(`/tasks/${taskId}/items/${itemId}/done`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(note && note.trim() ? { note: note.trim() } : {}),
  });
}

/** Edit (or clear, with '') the viewer's own done-note on an item. */
export function updateTaskItemNote(
  taskId: string,
  itemId: string,
  note: string,
): Promise<{ task: TaskDto }> {
  return apiFetch(`/tasks/${taskId}/items/${itemId}/note`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
}

/** Acknowledge (accept) the viewer's own assignment on an item — optional. */
export function acceptTaskItem(taskId: string, itemId: string): Promise<{ task: TaskDto }> {
  return apiFetch(`/tasks/${taskId}/items/${itemId}/accept`, { method: 'POST' });
}

/** Creator edits the task title and/or global deadline (reschedules reminders). */
export function updateTask(
  taskId: string,
  patch: { title?: string; globalDeadline?: string; description?: string },
): Promise<{ task: TaskDto }> {
  return apiFetch(`/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/** Creator cancels the task (withdraws reminders, notifies the group). */
export function cancelTask(taskId: string): Promise<{ task: TaskDto }> {
  return apiFetch(`/tasks/${taskId}`, { method: 'DELETE' });
}

/** Creator replaces the assignee set of one item. */
export function setTaskItemAssignees(
  taskId: string,
  itemId: string,
  lineUids: string[],
): Promise<{ task: TaskDto; taskDone: boolean }> {
  return apiFetch(`/tasks/${taskId}/items/${itemId}/assignees`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lineUids }),
  });
}

/** Creator attaches a reference link to the task. */
export function addTaskLink(
  taskId: string,
  url: string,
  label?: string,
): Promise<{ task: TaskDto }> {
  return apiFetch(`/tasks/${taskId}/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(label && label.trim() ? { url, label: label.trim() } : { url }),
  });
}

/** Creator removes a task link. */
export function deleteTaskLink(taskId: string, linkId: string): Promise<{ task: TaskDto }> {
  return apiFetch(`/tasks/${taskId}/links/${linkId}`, { method: 'DELETE' });
}

/** The assignee-picker roster for a group (used by the assignee editor). */
export function listGroupTaskMembers(groupId: string): Promise<{ members: GroupMemberDto[] }> {
  return apiFetch(`/groups/${encodeURIComponent(groupId)}/members`);
}
