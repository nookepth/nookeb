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
  TaskFileDto,
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
    // Parse the error body so quota (429) and plan-gate (403) rejections reach
    // the caller with their `code`/`feature`/`limit` intact. This used to throw
    // a bare "API error 429", which left every page with nothing to say beyond
    // a generic failure. parseApiError guarantees a machine code never lands in
    // `message`, so this cannot start leaking codes into the UI.
    const body = (await res.json().catch(() => null)) as
      | (Record<string, unknown> & { error?: string; code?: string })
      | null;
    throw parseApiError(res.status, body);
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
    /** Quota/plan context when the API sent it (feature, limit, used, reset_at). */
    public details?: ApiErrorDetails,
  ) {
    super(message);
  }
}

export interface ApiErrorDetails {
  feature?: string;
  limit?: number;
  used?: number;
  resetAt?: string;
  requiredPlan?: string;
  currentPlan?: string;
}

/** SCREAMING_SNAKE_CASE — the shape of every machine code the API emits. */
const CODE_RE = /^[A-Z][A-Z0-9_]{2,}$/;

/**
 * Turn an error body into an ApiError, and — critically — never let a machine
 * code end up in `message`, where pages render it straight at the user.
 *
 * Two response shapes exist in this API and they disagree about which field
 * holds the code:
 *
 *   membership quota (middleware/quota.ts):
 *     { error: 'QUOTA_EXCEEDED', feature, limit, used, reset_at }   ← code in `error`
 *   everything else (vault, storage, boxes):
 *     { error: 'พื้นที่ไม่เพียงพอ', code: 'QUOTA_EXCEEDED' }        ← code in `code`
 *
 * Pages that fell back to `err.message` therefore printed the literal string
 * "QUOTA_EXCEEDED" to users whenever a membership quota rejected them. So when
 * `error` looks like a code and no `code` field was sent, it is promoted to
 * `code` and the message is left empty — forcing the caller through
 * lib/quota-errors.ts instead of rendering the raw token.
 */
export function parseApiError(
  status: number,
  body: (Record<string, unknown> & { error?: string; code?: string }) | null,
): ApiError {
  const rawError = typeof body?.error === 'string' ? body.error : undefined;
  const rawCode = typeof body?.code === 'string' ? body.code : undefined;

  const errorIsCode = rawError !== undefined && rawCode === undefined && CODE_RE.test(rawError);
  const code = rawCode ?? (errorIsCode ? rawError : undefined);
  const message = errorIsCode ? '' : (rawError ?? `API error ${status}`);

  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

  return new ApiError(status, message, code, {
    feature: str(body?.feature),
    limit: num(body?.limit),
    used: num(body?.used),
    resetAt: str(body?.reset_at),
    requiredPlan: str(body?.required_plan),
    currentPlan: str(body?.current_plan),
  });
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
    throw parseApiError(res.status, body);
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

export interface AdminProInterestGiftbox {
  feature: string; // 'audio' | 'video'
  taps: number;
}

export interface AdminProInterestDaily {
  day: string;
  giftboxTaps: number;
}

export interface AdminProInterest {
  days: number;
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

/* ==========================================================================
   Admin OPS — the /admin/system page (routes/admin-ops.ts, migration 058)

   Everything above answers "how is the product doing". These answer "is the
   machine running". The API fails soft on every one of them (a dead Redis or
   an unapplied 058 degrades to empty/zero with a 200), so these fetchers only
   ever throw on auth (401/403) or a transport failure — the panels themselves
   are always renderable.
   ========================================================================== */

export type AdminQueueKey = 'file' | 'task' | 'sheets' | 'membership';

export interface AdminQueueStat {
  key: AdminQueueKey;
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
  /** false when the counts could not be read (Redis down, queue not built). */
  ok: boolean;
  error: string | null;
}

export interface AdminFailedJob {
  id: string;
  name: string;
  jobType: string | null;
  attemptsMade: number;
  reason: string | null;
  failedAt: string | null;
  timestamp: string | null;
}

export interface AdminQueues {
  queues: AdminQueueStat[];
  /** null unless the request asked for `failed=1`. */
  failed: Record<AdminQueueKey, AdminFailedJob[]> | null;
  backlog: number;
  failedTotal: number;
  checkedAt: string;
}

export function getAdminQueues(withFailed = false): Promise<AdminQueues> {
  return apiFetch(`/admin/system/queues${withFailed ? '?failed=1' : ''}`);
}

export interface AdminHealth {
  api: {
    healthy: boolean;
    checks: { redis: 'ok' | 'error'; db: 'ok' | 'error' };
    commit: string;
  };
  worker: {
    /** false = WORKER_HEALTH_URL unset. NOT the same as "down". */
    configured: boolean;
    reachable: boolean;
    healthy: boolean;
    status: string;
    commit: string | null;
    checks: Record<string, string> | null;
  };
  checkedAt: string;
}

export function getAdminHealth(): Promise<AdminHealth> {
  return apiFetch(`/admin/system/health`);
}

export interface AdminReminderDay {
  day: string;
  scheduled: number;
  sent: number;
  failed: number;
  cancelled: number;
  pending: number;
}

export interface AdminDiaryAddonDay {
  day: string;
  sent: number;
  skipped: number;
  skippedWrote: number;
  skippedLapsed: number;
}

export interface AdminPushFailure {
  id: string;
  taskId: string | null;
  taskTitle: string | null;
  taskStatus: string | null;
  remindType: string;
  remindAt: string;
  failedAt: string;
}

export interface AdminAllowanceRow {
  userId: string;
  displayName: string | null;
  plan: string | null;
  used: number;
  limit: number;
  unlimited: boolean;
  /** null when unlimited — a % of infinity is not a number. */
  pctUsed: number | null;
}

export interface AdminNotifications {
  days: number;
  period: string;
  resetAt: string;
  totals: { scheduled: number; sent: number; failed: number; cancelled: number; pending: number };
  /** sent / (sent + failed), %. null when nothing was attempted. */
  deliveryRate: number | null;
  daily: AdminReminderDay[];
  diaryDaily: AdminDiaryAddonDay[];
  failures: AdminPushFailure[];
  allowance: AdminAllowanceRow[];
}

export function getAdminNotifications(days = 30): Promise<AdminNotifications> {
  return apiFetch(`/admin/notifications?days=${days}`);
}

export interface AdminQuotaFeatureRow {
  feature: string;
  rows: number;
  totalUsed: number;
  /** >=80% and <100% — disjoint from atLimit. */
  nearLimit: number;
  atLimit: number;
}

export interface AdminQuotaPressureRow {
  userId: string;
  displayName: string | null;
  plan: string | null;
  feature: string;
  scopeId: string;
  used: number;
  limit: number;
  pctUsed: number;
}

export interface AdminQuotas {
  period: string;
  resetAt: string;
  /** true when the paged read hit its cap and the roll-up is a floor. */
  truncated: boolean;
  byFeature: AdminQuotaFeatureRow[];
  pressure: AdminQuotaPressureRow[];
}

export function getAdminQuotas(): Promise<AdminQuotas> {
  return apiFetch(`/admin/quotas`);
}

export interface AdminPlanMixRow {
  plan: string;
  count: number;
  pct: number;
}

export interface AdminSubscriptionRow {
  id: string;
  userId: string;
  displayName: string | null;
  plan: string;
  billingCycle: string;
  priceThb: number;
  status: string;
  currentPeriodEnd: string;
  cancelledAt: string | null;
}

export interface AdminBoostRow {
  id: string;
  userId: string;
  displayName: string | null;
  groupId: string;
  activatedAt: string;
  expiresAt: string;
}

export interface AdminMembership {
  totalUsers: number;
  planMix: AdminPlanMixRow[];
  /** Raw users.plan values, so a legacy 'team' row stays visible. */
  rawPlanCounts: { raw: string; count: number }[];
  renewals: {
    activeSubscriptions: number;
    dueIn7Days: number;
    dueIn30Days: number;
    mrrThb: number;
    /** true when the MRR figure was computed over a capped page. */
    mrrIsBounded: boolean;
  };
  subscriptions: AdminSubscriptionRow[];
  boosts: AdminBoostRow[];
  diaryAddonActive: number;
  monthlyQuotas: Record<string, Record<string, number>>;
}

export function getAdminMembership(): Promise<AdminMembership> {
  return apiFetch(`/admin/membership`);
}

export interface AdminSupportTicket {
  id: string;
  userId: string;
  displayName: string | null;
  subject: string;
  planAtCreation: string;
  slaHours: number;
  dueAt: string;
  onboardingCall: boolean;
  status: string;
  firstResponseAt: string | null;
  createdAt: string;
  breached: boolean;
  hoursRemaining: number;
}

export interface AdminSupportTickets {
  status: string;
  tickets: AdminSupportTicket[];
  breachedCount: number;
}

export function getAdminSupportTickets(status = 'open'): Promise<AdminSupportTickets> {
  return apiFetch(`/admin/support/tickets?status=${encodeURIComponent(status)}`);
}

export interface AdminStorageLedger {
  liveFiles: number;
  liveBytes: number;
  trashedFiles: number;
  trashedBytes: number;
  purgedFiles: number;
  processingFiles: number;
  errorFiles: number;
  vaultLiveFiles: number;
  vaultLiveBytes: number;
  usersTotal: number;
  usersOver80: number;
  usersOverLimit: number;
  storageUsedSum: number;
  storageLimitSum: number;
  /** false = migration 058 not applied; render "—", not a confident zero. */
  available: boolean;
}

export interface AdminStuckFile {
  id: string;
  name: string;
  status: string;
  bytes: number;
  spaceId: string | null;
  uploadedBy: string | null;
  lineSource: string | null;
  createdAt: string;
  stuckMinutes: number;
}

export interface AdminErroredFile {
  id: string;
  name: string;
  status: string;
  bytes: number;
  uploadedBy: string | null;
  createdAt: string;
}

export interface AdminStuckFiles {
  thresholdMinutes: number;
  ledger: AdminStorageLedger;
  stuck: AdminStuckFile[];
  errored: AdminErroredFile[];
}

export function getAdminStuckFiles(): Promise<AdminStuckFiles> {
  return apiFetch(`/admin/system/stuck-files`);
}

/* ---- Admin user detail drawer (GET /admin/users/:id) ---- */

export interface AdminUserQuota {
  feature: string;
  used: number;
  limit: number;
  unlimited: boolean;
  resetAt: string | null;
}

export interface AdminUserSubscription {
  id: string;
  plan: string;
  billingCycle: string;
  priceThb: number;
  status: string;
  startedAt: string;
  currentPeriodEnd: string;
  cancelledAt: string | null;
}

export interface AdminUserBoost {
  id: string;
  groupId: string;
  activatedAt: string;
  expiresAt: string;
}

/**
 * Google Sheets link state. Deliberately carries NO token field — the API
 * never selects `encrypted_token`, and this type is the client-side statement
 * of that contract.
 */
export interface AdminUserGoogle {
  connected: boolean;
  googleEmail?: string | null;
  sheetId?: string | null;
  sheetUrl?: string | null;
  lastSyncedAt?: string | null;
  lastError?: string | null;
  connectedAt?: string;
}

export interface AdminUserDetail {
  user: {
    id: string;
    lineUserId: string;
    displayName: string | null;
    plan: string;
    normalizedPlan: string;
    storageUsed: number;
    storageLimit: number;
    /**
     * Admin manual locker ceiling (migration 059). null = no override, i.e.
     * storageLimit came from the plan. Optional so a response from an API that
     * predates 059 still typechecks.
     */
    storageLimitOverride?: number | null;
    createdAt: string;
    isAdmin: boolean;
    /**
     * Account suspension (migration 060). null = active. Optional so a response
     * from an API that predates 060 still typechecks — and `undefined` must
     * render exactly like null, never like "unknown state".
     */
    suspendedAt?: string | null;
    suspendedReason?: string | null;
  };
  quotas: AdminUserQuota[];
  subscriptions: AdminUserSubscription[];
  boosts: AdminUserBoost[];
  google: AdminUserGoogle;
  content: { fileCount: number; fileBytes: number; vaultFileCount: number };
}

export function getAdminUserDetail(id: string): Promise<AdminUserDetail> {
  return apiFetch(`/admin/users/${id}`);
}

/* ==========================================================================
   Admin TIER 2 — WRITE actions.

   Everything above this point reads. Everything below CHANGES someone else's
   account, or the whole product's messaging, and every one of them is recorded
   in admin_audit_log server-side (migration 059).

   Two client-side rules follow from that:
     * every caller confirms first — these are not undo-able from the UI;
     * every caller surfaces the failure. Unlike the read fetchers, whose
       endpoints fail soft to empty payloads, these genuinely 4xx/5xx, and a
       500 specifically means "the write was reverted because it could not be
       audited" — the user must be told, never left looking at an optimistic
       value that no longer exists on the server.
   ========================================================================== */

export interface AdminSettings {
  push_enabled: boolean;
}

export function adminGetSettings(): Promise<AdminSettings> {
  return apiFetch(`/admin/settings`);
}

/** Global LINE push kill switch. Affects the API and the worker within 60 s. */
export function adminSetPushEnabled(enabled: boolean): Promise<AdminSettings> {
  return apiFetch(`/admin/settings/push_enabled`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

/** The RAW values users.plan may hold — 'team' is legacy and folds to premium. */
export type AdminPlanValue = 'free' | 'pro' | 'premium' | 'team';

export interface AdminPlanChangeResult {
  id: string;
  plan: AdminPlanValue;
  normalizedPlan: string;
  storageLimit: number;
  storageLimitOverride: number | null;
  /** false when the user already held that plan — the call was a no-op. */
  changed: boolean;
}

export function adminSetUserPlan(id: string, plan: AdminPlanValue): Promise<AdminPlanChangeResult> {
  return apiFetch(`/admin/users/${id}/plan`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan }),
  });
}

export interface AdminStorageOverrideResult {
  id: string;
  storageLimitOverride: number | null;
  storageLimit: number;
}

/** `bytes: null` removes the override and restores the plan's own allowance. */
export function adminSetStorageOverride(
  id: string,
  bytes: number | null,
): Promise<AdminStorageOverrideResult> {
  return apiFetch(`/admin/users/${id}/storage-override`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bytes }),
  });
}

export interface AdminQuotaResetResult {
  userId: string;
  feature: string;
  period: string;
  rowsReset: number;
  previousUsed: number;
}

/** Zeroes one monthly counter for the CURRENT period. 404 when no row exists. */
export function adminResetQuota(id: string, feature: string): Promise<AdminQuotaResetResult> {
  return apiFetch(`/admin/users/${id}/quotas/${encodeURIComponent(feature)}/reset`, {
    method: 'POST',
  });
}

export interface AdminRevokeSessionResult {
  id: string;
  sessionVersion: number;
}

/** Invalidates every JWT the user holds. 409 when another admin raced this one. */
export function adminRevokeSession(id: string): Promise<AdminRevokeSessionResult> {
  return apiFetch(`/admin/users/${id}/revoke-sessions`, { method: 'POST' });
}

/** Requeue one FAILED job. 409 when the job is in any other state. */
export function adminRetryJob(queue: AdminQueueKey, jobId: string): Promise<{ ok: true }> {
  return apiFetch(`/admin/system/queues/${queue}/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: 'POST',
  });
}

/** Delete one FAILED job. IRREVERSIBLE — the payload goes with it. */
export function adminRemoveJob(queue: AdminQueueKey, jobId: string): Promise<{ ok: true }> {
  return apiFetch(`/admin/system/queues/${queue}/jobs/${encodeURIComponent(jobId)}/remove`, {
    method: 'POST',
  });
}

/** Stamps cancelled_at on every unsent, uncancelled reminder for one task. */
export function adminCancelReminders(taskId: string): Promise<{ taskId: string; cancelled: number }> {
  return apiFetch(`/admin/tasks/${taskId}/cancel-reminders`, { method: 'POST' });
}

export interface AdminTicketUpdate {
  status?: 'answered' | 'closed';
  /** Recorded in the audit row — support_tickets has no reply column. */
  reply?: string;
}

export interface AdminTicketUpdateResult {
  ticket: {
    id: string;
    userId: string;
    subject: string;
    status: string;
    firstResponseAt: string | null;
    slaHours: number;
    dueAt: string;
    planAtCreation: string;
    createdAt: string;
  };
}

export function adminUpdateTicket(id: string, body: AdminTicketUpdate): Promise<AdminTicketUpdateResult> {
  return apiFetch(`/admin/support/tickets/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/* ==========================================================================
   Admin TIER 3 — runtime flags, LINE allowance, push + job history,
   R2 reconciliation, account suspension.

   The reads below follow the same fail-soft contract as every other
   /admin/system fetcher: the server degrades to an empty payload rather than
   erroring, so a panel renders "—" instead of taking the page down. The
   WRITES follow the TIER 2 contract — they genuinely 4xx/5xx, they are audited
   server-side, and every caller must surface the failure.
   ========================================================================== */

/** Every runtime switch, as the admin page knows them. */
export type AdminFlagKey =
  | 'push_enabled'
  | 'diary_reminder_enabled'
  | 'diary_addon_enabled'
  | 'scan_enhance_enabled'
  | 'scan_ocr_enabled'
  | 'virus_scan_enabled';

export interface AdminFlags {
  flags: Record<string, boolean>;
  /**
   * Keys whose value could NOT be read and are showing their documented
   * fallback instead. The page marks these — a switch rendered from a default
   * is a switch that may not reflect the server.
   */
  stale: string[];
  fallbacks: Record<string, boolean>;
}

export function getAdminFlags(): Promise<AdminFlags> {
  return apiFetch(`/admin/flags`);
}

export interface AdminFlagUpdateResult {
  key: AdminFlagKey;
  enabled: boolean;
  /**
   * diary_reminder_enabled only: whether the BullMQ repeatable was re-registered
   * in the same request. `false` means the flag saved but the schedule will not
   * agree with it until the next worker boot.
   */
  scheduleUpdated?: boolean;
}

/** Flips one runtime switch. Affects the API and the worker within 60 s. */
export function adminSetFlag(key: AdminFlagKey, enabled: boolean): Promise<AdminFlagUpdateResult> {
  return apiFetch(`/admin/flags/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

export interface AdminLineQuota {
  /** 'limited' = a real ceiling · 'unlimited' = no cap · 'none' = we could not find out. */
  type: 'none' | 'limited' | 'unlimited';
  /** null for BOTH 'unlimited' and 'none' — neither has a number. */
  limit: number | null;
  consumed: number;
  remaining: number | null;
  fetchedAt: string;
}

/** LINE's OWN monthly push allowance — the one quota figure that is not ours. */
export function getAdminLineQuota(): Promise<AdminLineQuota> {
  return apiFetch(`/admin/line-quota`);
}

export type AdminPushLogStatus = 'sent' | 'failed' | 'blocked_quota' | 'blocked_flag';

export interface AdminPushLogEntry {
  id: string;
  toId: string;
  toKind: string;
  context: string;
  refId: string | null;
  messageCount: number;
  status: string;
  httpStatus: number | null;
  error: string | null;
  createdAt: string;
}

export interface AdminPushLog {
  days: number;
  context: string | null;
  status: string | null;
  truncated: boolean;
  totals: {
    sent: number;
    failed: number;
    blocked_quota: number;
    blocked_flag: number;
    messages: number;
  };
  /** Over attempted pushes; blocked_flag is excluded (a deliberate silence). */
  deliveryRate: number | null;
  entries: AdminPushLogEntry[];
}

export function getAdminPushLog(
  days: number,
  opts?: { context?: string; status?: string },
): Promise<AdminPushLog> {
  const qs = new URLSearchParams({ days: String(days) });
  if (opts?.context) qs.set('context', opts.context);
  if (opts?.status) qs.set('status', opts.status);
  return apiFetch(`/admin/push-log?${qs.toString()}`);
}

export interface AdminJobThroughputGroup {
  queue: string;
  jobName: string;
  status: 'completed' | 'failed';
  count: number;
  /** null when no job in the bucket carried a measured duration. Never 0. */
  avgDurationMs: number | null;
}

export interface AdminJobThroughput {
  days: number;
  queue: string;
  truncated: boolean;
  totals: { completed: number; failed: number; successRate: number | null };
  groups: AdminJobThroughputGroup[];
}

export function getAdminJobThroughput(days: number, queue = 'all'): Promise<AdminJobThroughput> {
  return apiFetch(`/admin/system/job-throughput?days=${days}&queue=${queue}`);
}

export interface AdminR2ReconcileStatus {
  status: string;
  progress?: number;
  result?: { orphans: string[]; missing: string[]; summary: string } | null;
  failedReason?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export function getAdminR2ReconcileStatus(): Promise<AdminR2ReconcileStatus> {
  return apiFetch(`/admin/system/r2-reconcile/status`);
}

/** Starts the drift audit. 409 when one is already waiting or running. */
export function adminStartR2Reconcile(): Promise<{ jobId: string; queued: true }> {
  return apiFetch(`/admin/system/r2-reconcile`, { method: 'POST' });
}

export interface AdminSuspendResult {
  id: string;
  suspendedAt: string | null;
  suspendedReason: string | null;
  sessionVersion?: number;
}

/** Blocks every authenticated request AND kills existing tokens. 409 if already suspended. */
export function adminSuspendUser(id: string, reason: string): Promise<AdminSuspendResult> {
  return apiFetch(`/admin/users/${id}/suspend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
}

/** 409 when the user is not suspended. Does not restore the killed sessions. */
export function adminUnsuspendUser(id: string): Promise<AdminSuspendResult> {
  return apiFetch(`/admin/users/${id}/unsuspend`, { method: 'POST' });
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
      notification_enabled: settings.notificationEnabled,
    }),
  });
}

/**
 * Toggle the LINE-push opt-in on its own (migration 053).
 *
 * Its own endpoint rather than a field on the PUT above so the toggle can be
 * optimistic without carrying — and therefore without being able to overwrite —
 * the banner time and timezone the user may be editing at the same moment.
 * Returns the value the server stored; reconcile against it rather than
 * assuming the optimistic value won.
 */
export function setDiaryPushEnabled(enabled: boolean): Promise<{ notificationEnabled: boolean }> {
  return apiFetch(`/diary/notification/push`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notification_enabled: enabled }),
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

export interface VaultTrashFileDto extends VaultFileDto {
  deletedAt: string;
  daysUntilPurge: number;
}

export interface VaultTrashResponse {
  retentionDays: number;
  files: VaultTrashFileDto[];
}

/**
 * ถังขยะห้องนิรภัย — deliberately NOT part of the general /trash listing.
 *
 * A vault filename is sensitive content in its own right, and /trash is
 * protected only by the session cookie. This endpoint sits behind the vault
 * unlock session, so call it only while the vault is open.
 */
export function listVaultTrash(): Promise<VaultTrashResponse> {
  return vaultFetch(`/trash`);
}

export function restoreVaultFile(fileId: string): Promise<{ success: boolean }> {
  return vaultFetch(`/trash/${fileId}/restore`, { method: 'POST' });
}

/**
 * Hard-delete one trashed vault file now instead of waiting for the purge.
 * Irreversible, so the PIN is required — the same re-verification (and the same
 * VaultPinError shape on a wrong PIN) as deleteVaultFile.
 */
export function purgeVaultFile(fileId: string, pin: string): Promise<{ success: boolean }> {
  return vaultFetch(`/trash/${fileId}/permanent`, {
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
    throw parseApiError(res.status, body);
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
      // Through parseApiError, NOT a hand-rolled ApiError. The membership quota
      // middleware answers `{ error: 'QUOTA_EXCEEDED', feature, limit, … }` —
      // the code lives in `error` with no `code` field — so building the error
      // here put that literal token in `message` and left `code`/`details`
      // empty, which is how "QUOTA_EXCEEDED" ended up rendered on the create
      // page. parseApiError promotes it to `code` and carries `feature` along.
      reject(parseApiError(xhr.status, body));
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

// ---- review loop (migration 045): creator รับงาน / ตีกลับ a submission ----

/** Creator accepts a submitted item (marks every assignee done). */
export function approveTaskItem(taskId: string, itemId: string): Promise<{ task: TaskDto; taskDone: boolean }> {
  return apiFetch(`/tasks/${taskId}/items/${itemId}/approve`, { method: 'POST' });
}

/** Creator sends a submitted item back with a mandatory reason. */
export function rejectTaskItem(taskId: string, itemId: string, note: string): Promise<{ task: TaskDto }> {
  return apiFetch(`/tasks/${taskId}/items/${itemId}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
}

// ---- task attachments (migration 045) ----

/**
 * The task's attachments WITH presigned download URLs (1h). Fetched separately
 * from getTask because those urls are minted per read (the task payload carries
 * `files` with `url: null`) — mirrors the LIFF `listTaskFiles`.
 */
export async function listTaskFiles(taskId: string): Promise<TaskFileDto[]> {
  const { files } = await apiFetch<{ files: TaskFileDto[] }>(`/tasks/${taskId}/files`);
  return files;
}

/** Remove an attachment (detach + soft-delete). Uploader or task creator only. */
export function deleteTaskFile(taskId: string, attachmentId: string): Promise<{ success: boolean }> {
  return apiFetch(`/tasks/${taskId}/files/${attachmentId}`, { method: 'DELETE' });
}

/**
 * Creator edits the task title and/or global deadline (reschedules reminders).
 *
 * §4c notifyOnlyPending is deliberately NOT in this patch shape: the API forces
 * it ON for every task and ignores whatever a client sends.
 */
export function updateTask(
  taskId: string,
  patch: {
    title?: string;
    globalDeadline?: string;
    description?: string;
  },
): Promise<{ task: TaskDto }> {
  return apiFetch(`/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/**
 * Download a task's .ics and hand it to the browser as a file.
 *
 * Fetches the BYTES rather than navigating to the endpoint. A plain
 * `<a href>`/redirect leaves the task page — and on iOS Safari a navigation to
 * a `text/calendar` response is just as likely to render as text or open a
 * blank tab as it is to hand off to Calendar. Fetch + blob keeps the user
 * exactly where they were and always produces a real file.
 *
 * GET /tasks/:id/ics is unauthenticated by design (the task UUID is the
 * capability — the button in the LINE Flex card has no cookie to send), so this
 * needs no session; it still goes through the same-origin proxy like every
 * other call.
 */
export async function downloadTaskIcs(taskId: string, filename = 'nookeb-task.ics'): Promise<void> {
  const res = await fetch(`${API_URL}/tasks/${taskId}/ics`);
  if (!res.ok) throw new ApiError(res.status, 'ดาวน์โหลดไฟล์ปฏิทินไม่สำเร็จ');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick, not immediately: Safari reads the blob
  // asynchronously after the click and a synchronous revoke races it to an
  // empty download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Google Sheets integration (migration 046) ----

export interface GoogleIntegrationStatus {
  connected: boolean;
  email?: string | null;
  sheetUrl?: string | null;
  lastSyncedAt?: string | null;
  /** set when the last sync failed — usually "reconnect needed" */
  lastError?: string | null;
}

/** Connection status. A 503 means the feature isn't configured on this
 * deployment (no OAuth client) — surfaced as `null` so the card can hide. */
export async function getGoogleIntegration(): Promise<GoogleIntegrationStatus | null> {
  try {
    return await apiFetch<GoogleIntegrationStatus>('/integrations/google');
  } catch (err) {
    if (err instanceof ApiError && err.status === 503) return null;
    throw err;
  }
}

/**
 * Start the OAuth flow. The API returns the consent URL as JSON and WE do the
 * top-level navigation — a 302 from the API would be followed by fetch() and
 * land Google's HTML in a JSON parse instead of moving the browser.
 */
export async function startGoogleConnect(): Promise<void> {
  const { url } = await apiFetch<{ url: string }>('/integrations/google/auth');
  window.location.href = url;
}

export function disconnectGoogle(): Promise<{ success: boolean }> {
  return apiFetch('/integrations/google', { method: 'DELETE' });
}

/**
 * Backfill the tasks that existed before the sheet did.
 *
 * Returns as soon as the job is QUEUED, not when the import finishes — a full
 * backfill is hundreds of Sheets calls. The result shows up in the sheet's own
 * ภาพรวม tab ("ดึงล่าสุด … · N งาน") and in `lastSyncedAt` here.
 */
export function syncGoogleHistorical(): Promise<{ queued: boolean }> {
  return apiFetch('/integrations/google/sync-historical', { method: 'POST' });
}

export interface TaskExportOptions {
  /** 'YYYY-MM-DD', Bangkok calendar days; both bounds inclusive */
  from?: string;
  to?: string;
  /** item status to keep; 'all' (default) keeps every one */
  status?: 'all' | 'pending' | 'in_progress' | 'done' | 'cancelled' | 'submitted' | 'rejected';
}

/**
 * Download the caller's tasks as .xlsx and hand the file to the browser.
 *
 * Not routed through apiFetch: that helper parses every response as JSON, and
 * this one is a binary body whose FILENAME lives in Content-Disposition. The
 * object URL is revoked right after the click — leaving it alive pins the whole
 * workbook in memory for the life of the tab.
 */
export async function exportTasksXlsx(opts: TaskExportOptions = {}): Promise<void> {
  const query = new URLSearchParams({ format: 'xlsx' });
  if (opts.from) query.set('from', opts.from);
  if (opts.to) query.set('to', opts.to);
  if (opts.status && opts.status !== 'all') query.set('status', opts.status);

  const res = await fetch(`${API_URL}/tasks/export?${query}`);
  if (res.status === 401) {
    clearSession();
    throw new ApiError(401, 'Unauthorized');
  }
  if (!res.ok) throw new ApiError(res.status, `API error ${res.status}`);

  const disposition = res.headers.get('Content-Disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'nookeb-tasks.xlsx';

  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Creator cancels the task (withdraws reminders, notifies the group). */
export function cancelTask(taskId: string): Promise<{ task: TaskDto }> {
  return apiFetch(`/tasks/${taskId}`, { method: 'DELETE' });
}

/** Creator edits one item's title / deadline (null = fall back to the task
 *  deadline) / description. Mirrors the LIFF `PATCH /tasks/:id/items/:itemId`. */
export function updateTaskItem(
  taskId: string,
  itemId: string,
  patch: { title: string; deadline: string | null; description: string },
): Promise<{ task: TaskDto; taskDone: boolean }> {
  return apiFetch(`/tasks/${taskId}/items/${itemId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
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

/** Create a งานส่วนตัว from the dashboard modal — same POST /tasks the LIFF
 * flow uses, personal scope (migration 043): no groupId/assignees, owner and
 * assignee derive from the session. Single type; deadline must be future. */
export function createPersonalTask(input: {
  title: string;
  /** ISO datetime, must be in the future (API-enforced) */
  globalDeadline: string;
  description?: string;
  /** ความเร่งด่วน (migration 048); omitted = ปกติ */
  urgency?: 'urgent_max' | 'urgent' | 'normal' | 'relaxed';
  /**
   * §4b — reminder lead times in HOURS before the deadline, from the closed set
   * [3, 6, 24, 48, 72]. Omitted or empty = no reminders. How many may be sent is
   * the plan limit (free 1 / pro 2 / premium 4), enforced by the API, which
   * answers an over-limit request with 403 REMINDER_INTERVAL_LIMIT and an
   * off-menu value with 400 INVALID_REMINDER_INTERVAL.
   */
  reminderIntervals?: number[];
}): Promise<{ task: TaskDto }> {
  return apiFetch(`/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope: 'personal',
      type: 'single',
      title: input.title,
      globalDeadline: input.globalDeadline,
      ...(input.urgency ? { urgency: input.urgency } : {}),
      ...(input.reminderIntervals?.length
        ? { reminderIntervals: input.reminderIntervals }
        : {}),
      items: [
        {
          title: input.title,
          ...(input.description ? { description: input.description } : {}),
        },
      ],
    }),
  });
}

/* ============================================================
   ระบบสมาชิก (Membership) — routes/plans.ts, migration 051
   ============================================================ */

export type PlanKey = 'free' | 'pro' | 'premium';
export type BillingCycle = 'monthly' | 'yearly';

export interface PlanPricingDto {
  monthly: number;
  /** null = that plan has no yearly option (free). */
  yearly: number | null;
}

/**
 * Mirrors PlanSummary in apps/api/src/config/plans.ts — the single source of
 * truth for every limit and price. Nothing in the web app may hard-code a plan
 * number; read it from here.
 */
export interface PlanSummaryDto {
  plan: PlanKey;
  /** ชื่อแพ็กเกจจาก config/plans.ts — no emoji. */
  displayName: string;
  pricing: PlanPricingDto;
  lockerBytes: number;
  lockerMaxBytesWithReferrals: number;
  monthly: Record<string, number>;
  capacity: Record<string, number>;
  features: Record<string, boolean>;
  reminder: { maxSelectable: number; notifyOnlyPending: boolean };
  trashRetentionDays: number;
  slaHours: number;
}

export interface PlansResponse {
  plans: PlanSummaryDto[];
  reminderIntervalChoices: number[];
  currency: string;
}

export interface MyPlanResponse {
  plan: PlanKey;
  summary: PlanSummaryDto;
  referralCount: number;
  locker: { limitBytes: number; usedBytes: number };
  subscription: unknown | null;
}

export interface QuotaStateDto {
  feature: string;
  limit: number;
  used: number;
  /** null when the feature is unlimited on this plan. */
  remaining: number | null;
  unlimited: boolean;
}

export interface MyQuotasResponse {
  plan: PlanKey;
  /** ISO instant the monthly counters roll over (1st, 00:00 ICT). */
  resetAt: string;
  quotas: QuotaStateDto[];
}

/** Public price list — no session required. */
export function getPlans(): Promise<PlansResponse> {
  return apiFetch(`/plans`);
}

/** The caller's own membership + locker state. */
export function getMyPlan(): Promise<MyPlanResponse> {
  return apiFetch(`/plans/me`);
}

/**
 * Every monthly counter for the caller. Read-only — it deliberately creates no
 * quota rows, so polling it has no side effects.
 */
export function getMyQuotas(): Promise<MyQuotasResponse> {
  return apiFetch(`/plans/me/quotas`);
}

/** Pull one feature's state out of a quotas response, or null if absent. */
export function findQuota(
  quotas: MyQuotasResponse | null,
  feature: string,
): QuotaStateDto | null {
  return quotas?.quotas.find((q) => q.feature === feature) ?? null;
}

/* ============================================================
   บูธกลุ่ม (Group Boost) — routes/boosts.ts, migration 051
   ============================================================ */

export interface BoostStatusResponse {
  plan: PlanKey;
  limit: number;
  used: number;
  available: number;
  durationDays: number;
  boosts: { groupId: string; activatedAt: string; expiresAt: string }[];
}

/**
 * Boost slots + what is currently boosted.
 *
 * NOT plan-gated server-side on purpose: a free user must be able to see they
 * have 0 slots and what upgrading would buy them.
 */
export function getBoosts(): Promise<BoostStatusResponse> {
  return apiFetch(`/boosts`);
}

/* ============================================================
   หนูเก็บความทรงจำ (diary reminder add-on) — routes/diaryAddon.ts,
   migration 052
   ============================================================ */

export interface DiaryAddonSubscriptionDto {
  status: 'active' | 'cancelled' | 'expired';
  billingCycle: BillingCycle;
  priceThb: number;
  startedAt: string;
  expiresAt: string;
  cancelledAt: string | null;
  /** 'HH:MM', Bangkok wall clock. */
  notifyTime: string;
  daysLeft: number;
}

export interface DiaryAddonStatusResponse {
  /** ชื่อจาก config/plans.ts — no emoji, never hard-coded in a component. */
  name: string;
  /** Server-side master switch (DIARY_ADDON_ENABLED). */
  enabled: boolean;
  /** THE prices. A component must never write 49 or 365 itself. */
  pricing: { monthly: number; yearly: number };
  currency: string;
  /**
   * กล่องของขวัญ/เดือน the add-on guarantees. A FLOOR, not a replacement — a
   * premium holder keeps their higher plan quota, so never present this as the
   * user's own limit, only as what the add-on includes.
   */
  giftBoxQuota: number;
  active: boolean;
  subscription: DiaryAddonSubscriptionDto | null;
}

/**
 * The caller's add-on state plus the price list.
 *
 * Not gated: a user who does not hold the add-on still gets `active: false`
 * and the prices, which is what the plans page renders the offer from.
 */
export function getDiaryAddonStatus(): Promise<DiaryAddonStatusResponse> {
  return apiFetch(`/diary-addon/status`);
}

/**
 * NOT CALLED FROM THE UI. Payment is not live, so the plans page shows a
 * coming-soon modal instead — wiring a button to this would hand out a paid
 * add-on for free.
 *
 * TODO(payment): call this only from a payment-success flow.
 */
export function subscribeDiaryAddon(
  billingCycle: BillingCycle,
): Promise<{ subscription: DiaryAddonSubscriptionDto }> {
  return apiFetch(`/diary-addon/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ billingCycle }),
  });
}

/** Cancel = "do not renew". Access continues until `expiresAt`. */
export function cancelDiaryAddon(): Promise<{ cancelledAt: string; expiresAt: string }> {
  return apiFetch(`/diary-addon/cancel`, { method: 'POST' });
}

/** `notifyTime` is 'HH:MM' Bangkok time, 00:00–23:59. */
export function setDiaryAddonNotifyTime(notifyTime: string): Promise<{ notifyTime: string }> {
  return apiFetch(`/diary-addon/notify-time`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notifyTime }),
  });
}
