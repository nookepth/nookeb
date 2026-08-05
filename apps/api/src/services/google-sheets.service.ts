import { google, type sheets_v4 } from 'googleapis';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TaskItemStatus, TaskType } from '@nookeb/shared';
import { config } from '../config';
import { decryptSecret, deriveSecretKey, encryptSecret, isVaultConfigured } from './vault-crypto';
import {
  DEFAULT_URGENCY,
  FONT,
  appendStatusLog,
  ensureWorkspace,
  toSheetSerial,
} from './sheets-workspace.service';

/**
 * Google Sheets sync (migration 046) — each user connects THEIR OWN Google
 * account and gets a sheet they own outright: "หนูเก็บ — งานของฉัน".
 *
 * SECURITY — the reason migration 002 was dropped: refresh tokens are stored
 * ENCRYPTED (AES-256-GCM under a VAULT_MASTER_KEY-derived per-user key, see
 * vault-crypto's secret box). Nothing in this module ever writes a raw token,
 * logs one, or returns one past its own boundary.
 *
 * SCOPES — `drive.file` (NOT `drive`): it grants access only to files this app
 * itself created, so connecting cannot expose the user's existing Drive. That
 * also means we can create and keep updating our own sheet without ever being
 * able to read anything else the user owns.
 *
 * Sync is ALWAYS queued (BullMQ), never inline — see workers/sheetsWorker.ts.
 * Google being slow or down must not slow a task write, and a revoked token
 * must surface as a retryable job failure, not a 500 on task creation.
 */

/**
 * The OAuth client type, taken from `google.auth.OAuth2` rather than imported
 * from 'google-auth-library'. npm resolves TWO copies of that package (the
 * top-level one and `googleapis-common`'s nested one) and their OAuth2Client
 * declarations are structurally incompatible (private `redirectUri`), so a
 * direct import makes every `google.sheets({ auth })` call fail to typecheck.
 * Deriving it from the instance we actually construct always matches.
 */
type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
];

export const SHEET_TITLE = 'หนูเก็บ — งานของฉัน';
const TAB_TITLE = 'งานของฉัน';

/**
 * Columns. `รหัสงาน` is LAST and hidden: it is the sync key (find the row for a
 * task) and it must live in the sheet itself, not in our DB — the user can
 * reorder, sort and delete rows whenever they like, so any row index we cached
 * would be wrong by the next sync. Hidden because a UUID column is noise for a
 * human reader, not because it is secret.
 */
const HEADERS = [
  'ลำดับ',
  'ชื่องาน',
  'รายละเอียด',
  'ประเภท',
  'วันกำหนดส่ง',
  'ผู้สั่ง',
  'ผู้รับผิดชอบ',
  'สถานะ',
  'อัปเดตล่าสุด',
  'รหัสงาน',
];
const TASK_ID_COLUMN = HEADERS.length - 1; // 0-based index of รหัสงาน
const HEADER_ROWS = 1;

const TYPE_LABEL: Record<TaskType, string> = {
  single: 'งานเดียว',
  multi: 'หลายรายการ',
  recurring: 'งานประจำ',
};

/**
 * Exported so the workspace's STAGE_PROGRESS table can be asserted against it.
 * The calc sheet matches these exact strings; if the two drift, progress and
 * the pipeline dots silently fall back to blank instead of failing loudly.
 */
export const STATUS_LABEL: Record<TaskItemStatus, string> = {
  pending: 'รอดำเนินการ',
  in_progress: 'กำลังทำ',
  done: 'เสร็จแล้ว',
  cancelled: 'ยกเลิก',
  submitted: 'รอตรวจ',
  rejected: 'ตีกลับ',
};

/** Sheets wants 0–1 floats, not hex. */
function rgb(hex: string): sheets_v4.Schema$Color {
  return {
    red: parseInt(hex.slice(1, 3), 16) / 255,
    green: parseInt(hex.slice(3, 5), 16) / 255,
    blue: parseInt(hex.slice(5, 7), 16) / 255,
  };
}

const BRAND_RED = rgb('#B91C1C');
const WHITE = rgb('#FFFFFF');

/** Row background per status. 'ลบแล้ว' also gets strikethrough (see rowFormat). */
const ROW_COLOR: Record<TaskItemStatus | 'deleted', sheets_v4.Schema$Color> = {
  pending: WHITE,
  in_progress: rgb('#FEF9C3'),
  done: rgb('#DCFCE7'),
  submitted: rgb('#DBEAFE'),
  rejected: rgb('#FEE2E2'),
  cancelled: rgb('#F3F4F6'),
  deleted: rgb('#F3F4F6'),
};

export interface SheetTaskRow {
  /**
   * The row's identity — what is written to (and matched against) the hidden
   * รหัสงาน column J. A single/recurring task's row is its bare task id; a
   * multi task gets one row per sub-item keyed `{taskId}-{itemId}` (see
   * taskRowKey in sheets-row.ts).
   */
  key: string;
  /** The owning task — shared by every row of a multi task. */
  taskId: string;
  /**
   * Column-K label for the urgency chosen at creation (migration 048), or ''
   * when none was chosen. Written ONLY while K is still blank — after that the
   * column belongs to the user (see extensionUpdates).
   */
  urgency: string;
  title: string;
  description: string;
  type: TaskType;
  /** already formatted for display — Sheets gets a string, not a serial */
  deadline: string;
  createdBy: string;
  assignees: string;
  status: TaskItemStatus;
  updatedAt: string;
  /** soft-deleted/cancelled tasks are struck through, never removed (audit trail) */
  deleted: boolean;

  // ---- workspace extension columns (K–S), see sheets-workspace.service.ts ----
  /** "▓▓▓░░ 60%" — items finished out of items total. */
  progress: string;
  /** Attached links and file names, newline-separated. */
  links: string;
  /** ISO instants. These become REAL dates in hidden columns P/Q/R, which is
   * what lets every view do date maths instead of parsing the display text. */
  createdAt: string | null;
  doneAt: string | null;
  deadlineAt: string | null;
  /**
   * Column S — hours from assignment to the first รับทราบ, or '' when the row
   * has not been acknowledged yet (see acceptHours in sheets-row.ts: '' rather
   * than 0, because 0 would claim an instant acknowledgement that never
   * happened and would pull every per-person average down with it).
   */
  acceptHours: number | '';
}

export interface GoogleIntegrationRow {
  id: string;
  user_id: string;
  encrypted_token: string;
  google_email: string | null;
  sheet_id: string | null;
  sheet_url: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  /** FIX 1 (migration 063). Absent on a pre-063 database. */
  revoke_pending_at?: string | null;
  revoke_attempts?: number | null;
  revoke_last_error?: string | null;
}

/**
 * Postgres "column does not exist" for migration 063's revoke-pending columns.
 *
 * Same shape and same reasoning as isMissingTrialColumn in
 * services/sheets-trial.service.ts: SQLSTATE first (PostgREST forwards it
 * verbatim), message fallback because a schema-cache miss surfaces as PGRST204
 * with the column named in the message rather than as 42703.
 */
function isMissingRevokeColumn(error: { code?: string; message?: string; details?: string | null } | null): boolean {
  if (!error) return false;
  if (error.code === '42703') return true;
  return /revoke_pending_at|revoke_attempts|revoke_last_error/.test(
    `${error.message ?? ''} ${error.details ?? ''}`,
  );
}

/** Present iff the whole chain is configured — OAuth client AND the key that
 * encrypts the token. Routes and the worker both gate on this. */
export function isGoogleSheetsConfigured(): boolean {
  return Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) && isVaultConfigured();
}

export function redirectUri(): string {
  return `${config.APP_URL}/integrations/google/callback`;
}

function oauthClient(): OAuth2Client {
  if (!isGoogleSheetsConfigured()) {
    throw new Error('Google Sheets sync is not configured');
  }
  return new google.auth.OAuth2(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    redirectUri(),
  );
}

/**
 * Consent URL. `state` is an opaque, single-use nonce the ROUTE binds to the
 * caller's session (Redis) — it is the CSRF guard for the callback, so it must
 * never be the user id itself (that would let anyone graft their Google account
 * onto someone else's nookeb account by forging the callback).
 *
 * `prompt: 'consent'` + `access_type: 'offline'` is what makes Google actually
 * RETURN a refresh token: on a re-authorization it silently omits one unless
 * consent is re-requested, and an integration with no refresh token dies the
 * moment its access token expires an hour later.
 */
export function getAuthUrl(state: string): string {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  });
}

export interface ExchangedTokens {
  refreshToken: string;
  email: string | null;
}

/** Exchange the callback `code` for tokens + the account's email. */
export async function exchangeCode(code: string): Promise<ExchangedTokens> {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    // Without it we can only act for ~1 hour and then break silently.
    throw new Error('Google did not return a refresh token');
  }
  client.setCredentials(tokens);

  let email: string | null = null;
  try {
    const info = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
    email = info.data.email ?? null;
  } catch {
    // Cosmetic only (shown in the dashboard) — never fail a connect over it.
  }
  return { refreshToken: tokens.refresh_token, email };
}

// ---- persistence ----

/**
 * Whether migration 063 is applied, as learned at runtime.
 *
 * Starts optimistic and is flipped to `false` the first time PostgREST reports
 * the column missing, so a pre-063 deployment pays the failed round trip once
 * rather than on every write. Never flipped back: a migration is not un-applied
 * mid-process, and a stale `false` costs only the revoke-parking feature, which
 * is exactly what a pre-063 database cannot have anyway.
 */
let revokeColumnsSupported = true;

/** Spread helper: the revoke columns, or nothing at all on a pre-063 database. */
function revokeColumns<T extends Record<string, unknown>>(patch: T): T | Record<string, never> {
  return revokeColumnsSupported ? patch : {};
}

/** TEST SEAM. Reset the learned pre-063 state between cases. */
export function __setRevokeColumnsSupportedForTests(value: boolean): void {
  revokeColumnsSupported = value;
}

export async function saveIntegration(
  supabase: SupabaseClient,
  userId: string,
  refreshToken: string,
  email: string | null,
): Promise<void> {
  const key = await deriveSecretKey(userId);
  const { error } = await supabase.from('google_integrations').upsert(
    {
      user_id: userId,
      encrypted_token: encryptSecret(key, refreshToken),
      google_email: email,
      // Reconnecting drops the old sheet link: the new account can't write to
      // the previous account's spreadsheet, so keeping the id would leave the
      // UI pointing at a sheet every sync now 403s on.
      sheet_id: null,
      sheet_url: null,
      last_error: null,
      updated_at: new Date().toISOString(),
      // FIX 1 (063): reconnecting UNPARKS a disconnect whose revoke never
      // completed. Without this, a user who disconnected while Google was
      // unreachable and then reconnected would have their brand-new credential
      // revoked and deleted by the retry pass minutes later.
      ...revokeColumns({
        revoke_pending_at: null,
        revoke_attempts: 0,
        revoke_last_error: null,
      }),
    },
    { onConflict: 'user_id' },
  );
  if (error) {
    if (!isMissingRevokeColumn(error)) throw error;
    // Pre-063: retry without the columns that do not exist yet.
    revokeColumnsSupported = false;
    return saveIntegration(supabase, userId, refreshToken, email);
  }
}

/**
 * The user's LIVE integration, or null.
 *
 * FIX 1 (063): a row parked with `revoke_pending_at` is reported as NO
 * INTEGRATION. That is the whole reason the parking column can exist without
 * lying to the user — they pressed disconnect, so from this function outward
 * (the dashboard card, both sheetsWorker sync paths, the historical-backfill
 * guard) they ARE disconnected, immediately, even though the encrypted token
 * survives a few more minutes so the grant can still be revoked at Google.
 *
 * The retry pass is the only caller that wants those rows, and it queries the
 * table directly (listPendingRevocations).
 */
export async function getIntegration(
  supabase: SupabaseClient,
  userId: string,
): Promise<GoogleIntegrationRow | null> {
  if (revokeColumnsSupported) {
    const { data, error } = await supabase
      .from('google_integrations')
      .select('*')
      .eq('user_id', userId)
      .is('revoke_pending_at', null)
      .maybeSingle();
    if (!error) return (data as GoogleIntegrationRow | null) ?? null;
    if (!isMissingRevokeColumn(error)) throw error;
    revokeColumnsSupported = false;
  }

  // Pre-063 fallback: no parking column exists, so no row can be parked.
  const { data, error } = await supabase
    .from('google_integrations')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as GoogleIntegrationRow | null) ?? null;
}

/**
 * Park a disconnect whose Google revoke failed transiently — FIX 1.
 *
 * Returns `true` when the row was parked (the retry pass will finish the job),
 * `false` when migration 063 is not applied and there is nowhere to park it.
 * The caller decides what to do with `false`; routes/integrations.ts falls back
 * to the pre-fix behaviour of deleting the row, because refusing to disconnect
 * at all on an un-migrated deployment would be a worse regression than the leak
 * that deployment already had.
 */
export async function markRevokePending(
  supabase: SupabaseClient,
  userId: string,
  reason: string,
): Promise<boolean> {
  if (!revokeColumnsSupported) return false;

  const { data: prior } = await supabase
    .from('google_integrations')
    .select('revoke_attempts')
    .eq('user_id', userId)
    .maybeSingle();
  const attempts = Number((prior as { revoke_attempts?: number } | null)?.revoke_attempts ?? 0);

  const { error } = await supabase
    .from('google_integrations')
    .update({
      // Preserved across retries: the stamp is "when the user asked", which is
      // what an admin needs to see, not "when we last tried".
      revoke_pending_at: new Date().toISOString(),
      revoke_attempts: attempts + 1,
      // Truncated and pre-sanitised by the caller. NEVER a token — see the
      // logging rule on revokeRefreshToken.
      revoke_last_error: reason.slice(0, 300),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId);

  if (error) {
    if (isMissingRevokeColumn(error)) {
      revokeColumnsSupported = false;
      return false;
    }
    throw error;
  }
  return true;
}

/**
 * Bump only the attempt counter and reason on an ALREADY parked row.
 *
 * Distinct from markRevokePending so a retry cannot move `revoke_pending_at`
 * forward — that column answers "how long has this grant been outstanding?",
 * and a retry that refreshed it would reset the clock on the one number that
 * makes a permanently stuck grant visible.
 */
export async function recordRevokeRetryFailure(
  supabase: SupabaseClient,
  userId: string,
  attempts: number,
  reason: string,
): Promise<void> {
  if (!revokeColumnsSupported) return;
  const { error } = await supabase
    .from('google_integrations')
    .update({
      revoke_attempts: attempts + 1,
      revoke_last_error: reason.slice(0, 300),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId);
  if (error && !isMissingRevokeColumn(error)) throw error;
}

export interface PendingRevocation {
  user_id: string;
  encrypted_token: string;
  revoke_pending_at: string;
  revoke_attempts: number;
}

/**
 * Disconnects whose Google revoke has not succeeded yet, oldest first.
 *
 * NO TIME WINDOW, for the same reason listExpiredTrials has none (migration
 * 062's header): a windowed query drops anything a missed run skipped, and what
 * would be dropped here is a live third-party grant nobody will ever look at
 * again. `revoke_pending_at IS NOT NULL` is simply "still outstanding".
 */
export async function listPendingRevocations(
  supabase: SupabaseClient,
  limit: number,
): Promise<{ rows: PendingRevocation[]; supported: boolean }> {
  const { data, error } = await supabase
    .from('google_integrations')
    .select('user_id, encrypted_token, revoke_pending_at, revoke_attempts')
    .not('revoke_pending_at', 'is', null)
    .order('revoke_pending_at', { ascending: true })
    .limit(limit);

  if (error) {
    if (isMissingRevokeColumn(error)) {
      revokeColumnsSupported = false;
      return { rows: [], supported: false };
    }
    throw error;
  }
  return { rows: (data as PendingRevocation[] | null) ?? [], supported: true };
}

/**
 * Disconnect. Deletes the row outright — deliberately NOT a soft delete, and
 * the one place in this codebase where that is the correct call: rule 6 exists
 * to protect the USER's content from disappearing, while this row is a
 * third-party CREDENTIAL. Keeping a revoked token around as a tombstone is
 * pure liability with nothing to restore. The user's Sheet is untouched (they
 * own it) and their tasks are untouched.
 */
export async function deleteIntegration(supabase: SupabaseClient, userId: string): Promise<void> {
  const { error } = await supabase.from('google_integrations').delete().eq('user_id', userId);
  if (error) throw error;
}

export async function recordSyncResult(
  supabase: SupabaseClient,
  userId: string,
  patch: { sheetId?: string; sheetUrl?: string; error?: string | null },
): Promise<void> {
  const { error } = await supabase
    .from('google_integrations')
    .update({
      ...(patch.sheetId !== undefined ? { sheet_id: patch.sheetId } : {}),
      ...(patch.sheetUrl !== undefined ? { sheet_url: patch.sheetUrl } : {}),
      ...(patch.error !== undefined ? { last_error: patch.error } : {}),
      ...(patch.error === null || patch.error === undefined
        ? { last_synced_at: new Date().toISOString() }
        : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId);
  if (error) throw error;
}

/**
 * Authorized client for a stored integration. googleapis refreshes the access
 * token itself from the refresh token, so nothing is cached on our side — one
 * fewer secret to store, and a revoked grant fails loudly on the next call
 * instead of after a stale cache expires.
 */
export async function authorizedClient(
  userId: string,
  encryptedToken: string,
): Promise<OAuth2Client> {
  const client = oauthClient();
  const key = await deriveSecretKey(userId);
  client.setCredentials({ refresh_token: decryptSecret(key, encryptedToken) });
  return client;
}

/**
 * Revoke the stored grant at Google — หนูเก็บลองงาน's hard cutoff (migration 062).
 *
 * Revoking the REFRESH token invalidates every access token derived from it, so
 * one call ends the grant outright. There is nothing else to revoke: this
 * codebase never stores an access token (see authorizedClient).
 *
 * ── The return value, and why "already invalid" is success ────────────────
 *
 * `true`  the grant is gone — either we just revoked it, or Google says the
 *         token is already invalid/unknown. The second case is not a failure:
 *         the user revoked us from their Google account page, or a previous run
 *         revoked it and died before deleting the row. Treating it as an error
 *         would wedge that user in the sweep forever, retried every 15 minutes
 *         against a token that will never become valid again.
 * `false` transient — network, timeout, or a Google 5xx. The caller must leave
 *         the credential in place and let the next sweep retry. It must NOT
 *         delete the row: deleting it destroys the only copy of the token and
 *         with it any chance of ever revoking that grant.
 *
 * Nothing is thrown, so one unreachable Google cannot abort a whole sweep.
 *
 * NEVER LOG THE TOKEN, or the request body that carries it. Only the response
 * is inspected, exactly as describeGoogleError does.
 *
 * ── `context` (FIX 1) ─────────────────────────────────────────────────────
 *
 * Which path asked for the revoke, carried into every log line as
 * `[sheets-revoke:{context}]`. Three callers, three very different incidents:
 * a `trial_sweep` failure is a background retry that will come round again, a
 * `manual_disconnect` failure is a user standing in front of a spinner right
 * now, and a `pending_retry` failure that keeps recurring is a grant that may
 * never be revoked. Before this they all logged under one prefix and were
 * indistinguishable after the fact.
 */
export type RevokeContext = 'trial_sweep' | 'manual_disconnect' | 'pending_retry' | 'admin_force_expire';

export async function revokeRefreshToken(
  userId: string,
  encryptedToken: string,
  context: RevokeContext = 'trial_sweep',
): Promise<boolean> {
  const tag = `[sheets-revoke:${context}]`;
  let refreshToken: string;
  try {
    refreshToken = decryptSecret(await deriveSecretKey(userId), encryptedToken);
  } catch (err) {
    // Undecryptable (VAULT_MASTER_KEY rotated, row corrupt). The token is
    // unusable by us and unrecoverable, so there is nothing to revoke and
    // nothing to gain from retrying — let the caller delete the dead row.
    console.error(`${tag} could not decrypt stored token for revoke:`, (err as Error).message);
    return true;
  }

  try {
    const res = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return true;

    // 400 invalid_token = already revoked or never valid. See the doc comment.
    if (res.status === 400) {
      const detail = await res.text().catch(() => '');
      if (/invalid_token/i.test(detail)) return true;
      console.error(`${tag} google revoke rejected: 400 ${detail.slice(0, 200)}`);
      return false;
    }
    console.error(`${tag} google revoke failed: status=${res.status} user=${userId}`);
    return false;
  } catch (err) {
    console.error(`${tag} google revoke request failed for ${userId}:`, (err as Error).message);
    return false;
  }
}

/**
 * Safe, log-ready summary of a Google/googleapis error: HTTP status, the API/token
 * `reason`, and a human message — and NOTHING else. It reads only the error
 * *response* (status + `response.data.error`), never the request, so it can never
 * surface an access/refresh token. Both shapes are covered:
 *   - API errors:   { error: { code, status, message, errors: [{ reason }] } }
 *   - token errors: { error: 'invalid_grant', error_description }
 * Neither carries a secret, so message/error_description are safe to log.
 *
 * This exists because the worker used to swallow the real error behind a generic
 * string, which made a disabled-API 403 and a genuinely-revoked token look
 * identical in the logs — the exact ambiguity that leaves "why is it broken?"
 * unanswerable.
 */
export function describeGoogleError(err: unknown): {
  status?: number;
  reason?: string;
  message: string;
} {
  const e = err as {
    response?: { status?: number; data?: unknown };
    message?: string;
    code?: string | number;
  };
  const status = e?.response?.status ?? (typeof e?.code === 'number' ? e.code : undefined);
  let reason: string | undefined;
  let message = String(e?.message ?? 'unknown error');

  const data = e?.response?.data as
    | { error?: unknown; error_description?: string }
    | undefined;
  const apiErr = data?.error;
  if (apiErr && typeof apiErr === 'object') {
    const o = apiErr as { status?: string; message?: string; errors?: Array<{ reason?: string }> };
    reason = o.status ?? o.errors?.[0]?.reason;
    if (o.message) message = o.message;
  } else if (typeof apiErr === 'string') {
    reason = apiErr; // token endpoint: e.g. 'invalid_grant'
    if (data?.error_description) message = data.error_description;
  }
  return { status, reason, message };
}

/**
 * Config-level 403 — the Sheets/Drive API is disabled for the Cloud project, or
 * the project can't be reached. Reconnecting the user's Google account CANNOT fix
 * this (only an admin enabling the API can), so it must NOT be treated as an auth
 * error: doing so dead-ends the user in a reconnect loop and mislabels the cause.
 */
export function isServiceConfigError(err: unknown): boolean {
  const { reason } = describeGoogleError(err);
  return reason === 'accessNotConfigured' || reason === 'SERVICE_DISABLED';
}

/** True for the errors that mean "the user must reconnect", not "retry later". */
export function isAuthError(err: unknown): boolean {
  // A disabled-API / project-config 403 is retryable operator work, not a user
  // reconnect — keep it out of the auth bucket (see isServiceConfigError).
  if (isServiceConfigError(err)) return false;
  const { status, reason, message } = describeGoogleError(err);
  if (status === 401 || status === 403) return true;
  return /invalid_grant|invalid_client|unauthorized/i.test(`${reason ?? ''} ${message}`);
}

// ---- sheet creation + formatting ----

/** Create the user's sheet and apply the whole look in ONE batchUpdate. */
export async function createSheet(
  auth: OAuth2Client,
  opts: { syncUrl?: string } = {},
): Promise<{ sheetId: string; url: string }> {
  const sheets = google.sheets({ version: 'v4', auth });
  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: SHEET_TITLE, locale: 'th_TH', timeZone: 'Asia/Bangkok' },
      sheets: [
        {
          properties: {
            title: TAB_TITLE,
            gridProperties: { frozenRowCount: HEADER_ROWS, columnCount: HEADERS.length },
          },
        },
      ],
    },
  });

  const sheetId = created.data.spreadsheetId;
  const gid = created.data.sheets?.[0]?.properties?.sheetId ?? 0;
  if (!sheetId) throw new Error('Google returned no spreadsheetId');

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${TAB_TITLE}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADERS] },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        // Header: brand red, white bold. Arial throughout — the Sheets API
        // cannot install a custom font, so IBM Plex Sans Thai is only available
        // through the .xlsx export (see export.service.ts).
        {
          repeatCell: {
            range: { sheetId: gid, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                backgroundColor: BRAND_RED,
                horizontalAlignment: 'CENTER',
                textFormat: {
                  foregroundColor: WHITE,
                  bold: true,
                  fontFamily: FONT,
                  fontSize: 11,
                },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)',
          },
        },
        { updateSheetProperties: {
            properties: { sheetId: gid, gridProperties: { frozenRowCount: HEADER_ROWS } },
            fields: 'gridProperties.frozenRowCount',
        } },
        { setBasicFilter: { filter: { range: { sheetId: gid, startRowIndex: 0 } } } },
        { autoResizeDimensions: {
            dimensions: { sheetId: gid, dimension: 'COLUMNS', startIndex: 0, endIndex: HEADERS.length },
        } },
        // Hide the sync-key column — see the HEADERS note.
        { updateDimensionProperties: {
            range: {
              sheetId: gid,
              dimension: 'COLUMNS',
              startIndex: TASK_ID_COLUMN,
              endIndex: TASK_ID_COLUMN + 1,
            },
            properties: { hiddenByUser: true },
            fields: 'hiddenByUser',
        } },
      ],
    },
  });

  // Build the dashboard/views around the raw tab. Deliberately NOT fatal: if
  // this fails the user still gets a working synced table, and the worker's
  // version check rebuilds the workspace on the next sync.
  try {
    await ensureWorkspace(auth, sheetId, { syncUrl: opts.syncUrl });
  } catch (err) {
    console.error('[sheets] workspace build failed on create', describeGoogleError(err).message);
  }

  return {
    sheetId,
    url: created.data.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${sheetId}`,
  };
}

/** The tab's numeric gid, needed by every formatting request. */
async function tabGid(sheets: sheets_v4.Sheets, spreadsheetId: string): Promise<number> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const tab =
    meta.data.sheets?.find((s) => s.properties?.title === TAB_TITLE) ?? meta.data.sheets?.[0];
  const gid = tab?.properties?.sheetId;
  if (gid == null) throw new Error('sheet tab not found');
  return gid;
}

/**
 * The whole hidden รหัสงาน column, as raw strings indexed by 0-based sheet row.
 * One values.get serves every row of a task's sync (a multi task has several),
 * so the request count stays flat no matter how many sub-items a task grows.
 */
async function readKeyColumn(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
): Promise<string[]> {
  const column = String.fromCharCode(65 + TASK_ID_COLUMN); // 'J'
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${TAB_TITLE}!${column}:${column}`,
    majorDimension: 'COLUMNS',
  });
  return (res.data.values?.[0] ?? []).map((v) => String(v ?? ''));
}

function rowValues(row: SheetTaskRow, order: number): string[] {
  return [
    String(order),
    row.title,
    row.description,
    TYPE_LABEL[row.type] ?? row.type,
    row.deadline,
    row.createdBy,
    row.assignees,
    row.deleted ? 'ลบแล้ว' : (STATUS_LABEL[row.status] ?? row.status),
    row.updatedAt,
    row.key,
  ];
}

function rowFormatRequest(gid: number, rowIndex: number, row: SheetTaskRow): sheets_v4.Schema$Request {
  const deleted = row.deleted;
  return {
    repeatCell: {
      range: {
        sheetId: gid,
        startRowIndex: rowIndex,
        endRowIndex: rowIndex + 1,
        startColumnIndex: 0,
        endColumnIndex: HEADERS.length,
      },
      cell: {
        userEnteredFormat: {
          backgroundColor: deleted ? ROW_COLOR.deleted : ROW_COLOR[row.status],
          textFormat: {
            fontFamily: FONT,
            fontSize: 10,
            // Deleted rows are struck through and greyed, NEVER removed — the
            // sheet doubles as the user's audit trail (and mirrors rule 6's
            // spirit: nothing the user recorded silently disappears).
            strikethrough: deleted,
            foregroundColor: deleted ? rgb('#9CA3AF') : rgb('#111827'),
          },
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat)',
    },
  };
}

/**
 * The K–O half of an existing row, read BEFORE the sync overwrites A–J.
 *
 * Two of these columns belong to the user (ความเร่งด่วน, หมายเหตุ) and must
 * survive every sync; the previous สถานะ is what tells us whether to append a
 * line to the history column. Reading them costs one values.get.
 *
 * Nothing past O needs reading: P–S are derived outright from the task on every
 * write, so there is no prior state of theirs to preserve.
 */
async function readRowExtras(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  rowIndex: number,
): Promise<{ previousStatus: string; urgency: string; log: string }> {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${TAB_TITLE}!H${rowIndex + 1}:O${rowIndex + 1}`,
    });
    const cells = res.data.values?.[0] ?? [];
    return {
      previousStatus: String(cells[0] ?? ''), // H
      urgency: String(cells[3] ?? ''), // K
      log: String(cells[7] ?? ''), // O
    };
  } catch {
    // A read failure must not block the sync — worst case the history line for
    // this one transition is missed.
    return { previousStatus: '', urgency: '', log: '' };
  }
}

/**
 * The extension-column writes for one row: progress, links, history, dates and
 * time-to-acknowledge.
 *
 * OWNED RANGES — the contract the whole workspace rests on, so read this before
 * adding a column anywhere past J:
 *   A–J  the sync's, values AND background repainted on every write
 *   K    ความเร่งด่วน — the USER's, seeded here only while it is still blank
 *   L,M  ความคืบหน้า / ลิงก์ — this function's, rewritten every sync
 *   N    หมายเหตุ — the USER's, never written by anything
 *   O    ประวัติสถานะ — this function's, append-only
 *   P,Q,R  hidden real date serials — this function's
 *   S    ⏱ เวลาตอบรับ (ชม.) — this function's, blank until the first รับทราบ
 * Anything a future change adds must start at T, and must be declared in
 * MASTER_EXT (sheets-workspace.service.ts) so the header, width, number format
 * and grid width all move together.
 */
export function extensionUpdates(
  rowIndex: number,
  row: SheetTaskRow,
  prior: { previousStatus: string; urgency: string; log: string },
): sheets_v4.Schema$ValueRange[] {
  const line = rowIndex + 1;
  const statusLabel = row.deleted ? 'ลบแล้ว' : (STATUS_LABEL[row.status] ?? row.status);
  const updates: sheets_v4.Schema$ValueRange[] = [];

  // K — only ever filled when empty. It is the user's column after that. The
  // initial value is the urgency chosen at creation (migration 048), falling
  // back to ปกติ for tasks created without one.
  if (!prior.urgency) {
    updates.push({ range: `${TAB_TITLE}!K${line}`, values: [[row.urgency || DEFAULT_URGENCY]] });
  }

  updates.push({ range: `${TAB_TITLE}!L${line}:M${line}`, values: [[row.progress, row.links]] });

  const log = appendStatusLog(prior.log, prior.previousStatus || null, statusLabel, new Date());
  if (log !== prior.log) {
    updates.push({ range: `${TAB_TITLE}!O${line}`, values: [[log]] });
  }

  // P–S in one range so a row can never carry a deadline serial from this sync
  // next to an acknowledgement time from the last one.
  updates.push({
    range: `${TAB_TITLE}!P${line}:S${line}`,
    values: [[
      toSheetSerial(row.createdAt),
      toSheetSerial(row.doneAt),
      toSheetSerial(row.deadlineAt),
      row.acceptHours,
    ]],
  });

  return updates;
}

/** Strikethrough + grey for a row whose sub-item no longer exists. */
function strikeRowRequest(gid: number, rowIndex: number): sheets_v4.Schema$Request {
  return {
    repeatCell: {
      range: {
        sheetId: gid,
        startRowIndex: rowIndex,
        endRowIndex: rowIndex + 1,
        startColumnIndex: 0,
        endColumnIndex: HEADERS.length,
      },
      cell: {
        userEnteredFormat: {
          backgroundColor: ROW_COLOR.deleted,
          textFormat: {
            fontFamily: FONT,
            fontSize: 10,
            strikethrough: true,
            foregroundColor: rgb('#9CA3AF'),
          },
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat)',
    },
  };
}

/**
 * Write one task's rows into the sheet: update the existing row for each key,
 * append the ones that have never been written. Idempotent — running it twice
 * leaves the same rows.
 *
 * Three extra concerns beyond the one-row version this replaced:
 *   - LEGACY CLAIM: a multi task synced before per-item rows existed sits in
 *     the sheet as ONE row keyed by the bare task id. The first item row that
 *     finds no row of its own claims that legacy row (rewriting its key), so
 *     the upgrade happens in place with no duplicate and no lost user columns.
 *   - ORPHANS: a row whose `{taskId}-…` key no longer maps to a live item
 *     (item deleted, task restructured) is struck through like a deleted task
 *     — never removed, same audit-trail rule as everywhere else.
 *   - The append path reuses appendTaskRows, so there is exactly one place
 *     that knows the no-INSERT_ROWS rule.
 */
export async function syncTaskToSheet(
  auth: OAuth2Client,
  spreadsheetId: string,
  rows: SheetTaskRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const sheets = google.sheets({ version: 'v4', auth });
  const [gid, keyColumn] = await Promise.all([
    tabGid(sheets, spreadsheetId),
    readKeyColumn(sheets, spreadsheetId),
  ]);
  const taskId = rows[0]!.taskId;

  // Claimed = sheet rows already assigned to one of this sync's rows, so two
  // identical keys (user copy-pasted a row) can't both be written.
  const claimed = new Set<number>();
  const indexOf = (key: string): number =>
    keyColumn.findIndex((v, i) => v === key && i >= HEADER_ROWS && !claimed.has(i));

  const toUpdate: { rowIndex: number; row: SheetTaskRow }[] = [];
  const toAppend: SheetTaskRow[] = [];
  for (const row of rows) {
    let idx = indexOf(row.key);
    if (idx === -1 && row.key !== row.taskId) {
      // The legacy claim — see the doc comment.
      idx = indexOf(row.taskId);
    }
    if (idx === -1) {
      toAppend.push(row);
    } else {
      claimed.add(idx);
      toUpdate.push({ rowIndex: idx, row });
    }
  }

  // Rows that belong to this task but to no live item.
  const liveKeys = new Set(rows.map((r) => r.key));
  const orphanIndices = keyColumn
    .map((v, i) => ({ v, i }))
    .filter(
      ({ v, i }) =>
        i >= HEADER_ROWS &&
        !claimed.has(i) &&
        (v === taskId || v.startsWith(`${taskId}-`)) &&
        !liveKeys.has(v),
    )
    .map(({ i }) => i);

  const formatRequests: sheets_v4.Schema$Request[] = [];
  const valueData: sheets_v4.Schema$ValueRange[] = [];

  for (const { rowIndex, row } of toUpdate) {
    const prior = await readRowExtras(sheets, spreadsheetId, rowIndex);
    // Keep the ลำดับ the row already has — renumbering every row on each sync
    // would rewrite the whole sheet for one task change.
    valueData.push({
      range: `${TAB_TITLE}!A${rowIndex + 1}`,
      values: [rowValues(row, rowIndex)],
    });
    valueData.push(...extensionUpdates(rowIndex, row, prior));
    formatRequests.push(rowFormatRequest(gid, rowIndex, row));
  }

  for (const rowIndex of orphanIndices) {
    valueData.push({
      range: `${TAB_TITLE}!H${rowIndex + 1}`,
      values: [['ลบแล้ว']],
    });
    formatRequests.push(strikeRowRequest(gid, rowIndex));
  }

  if (valueData.length > 0) {
    // A–J and K–R written in one batch; the extension columns can therefore
    // never lag the task row within a single sync.
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data: valueData },
    });
  }
  if (formatRequests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: formatRequests },
    });
  }
  if (toAppend.length > 0) {
    await appendTaskRows(auth, spreadsheetId, toAppend);
  }
}

// ---- historical backfill (bulk append) ----

/**
 * Rows per append round-trip. 100 keeps one chunk's four API calls comfortably
 * inside Sheets' per-request payload limits while still importing a heavy
 * user's whole history in a handful of round-trips, and it bounds how much work
 * a retry repeats.
 */
export const HISTORICAL_CHUNK_SIZE = 100;

/**
 * Every รหัสงาน already present in the sheet.
 *
 * This is the duplicate guard for the backfill, and it reads the SHEET rather
 * than trusting our own record of what we synced: the user may have deleted
 * rows, and a task synced before we ever tracked a backfill timestamp has no
 * server-side marker at all. Column J is the only authority on "is this task
 * already in the sheet", exactly as it is for the single-task sync.
 */
export async function readSyncedTaskIds(
  auth: OAuth2Client,
  spreadsheetId: string,
): Promise<Set<string>> {
  const sheets = google.sheets({ version: 'v4', auth });
  const column = String.fromCharCode(65 + TASK_ID_COLUMN); // 'J'
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${TAB_TITLE}!${column}:${column}`,
    majorDimension: 'COLUMNS',
  });
  const values = res.data.values?.[0] ?? [];
  // Drop the header cell and any blanks; keep whatever else is there (including
  // the add-on's LOCAL-… ids, which must never collide with a real UUID).
  return new Set(
    values
      .slice(HEADER_ROWS)
      .map((v) => String(v ?? '').trim())
      .filter(Boolean),
  );
}

/**
 * Append many task rows in one pass — the bulk counterpart to syncTaskToSheet.
 *
 * It APPENDS ONLY: rows already in the sheet must be filtered out by the caller
 * (readSyncedTaskIds), because updating a live row is the single-task sync's
 * job and doing it here would clobber whatever the user has since put in their
 * own columns.
 *
 * Same append discipline as the single-row path and for the same reason: no
 * `insertDataOption: 'INSERT_ROWS'`. Inserting rows makes Sheets rewrite every
 * formula reference at or below the insertion point, which is precisely the
 * drift that walked _ข้อมูลคำนวณ off its own data. A backfill inserts hundreds
 * of rows at once, so it would not drift the workspace — it would demolish it.
 *
 * Returns the number of rows written.
 */
export async function appendTaskRows(
  auth: OAuth2Client,
  spreadsheetId: string,
  rows: SheetTaskRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const sheets = google.sheets({ version: 'v4', auth });
  const gid = await tabGid(sheets, spreadsheetId);

  let written = 0;
  for (let offset = 0; offset < rows.length; offset += HISTORICAL_CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + HISTORICAL_CHUNK_SIZE);

    const appended = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${TAB_TITLE}!A1`,
      valueInputOption: 'RAW',
      // OVERWRITE (the default) — see the note above. ลำดับ is stamped in the
      // follow-up write, once the real row numbers are known.
      requestBody: { values: chunk.map((row) => rowValues(row, 0)) },
    });

    // updatedRange looks like "'งานของฉัน'!A7:J106" — take the first row number.
    const match = /![A-Z]+(\d+)/.exec(appended.data.updates?.updatedRange ?? '');
    const firstRow = match ? Number(match[1]) - 1 : HEADER_ROWS + offset; // 0-based

    // ลำดับ = the row's position under the header, matching the single-row path.
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${TAB_TITLE}!A${firstRow + 1}:A${firstRow + chunk.length}`,
      valueInputOption: 'RAW',
      requestBody: { values: chunk.map((_row, i) => [String(firstRow + i)]) },
    });

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: chunk.map((row, i) => rowFormatRequest(gid, firstRow + i, row)),
      },
    });

    // K–R. A backfilled row has no prior state to preserve, so every row starts
    // with the default urgency and a single "เริ่มติดตาม" history line — the
    // same thing the live sync writes the first time it sees a task.
    const blank = { previousStatus: '', urgency: '', log: '' };
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: chunk.flatMap((row, i) => extensionUpdates(firstRow + i, row, blank)),
      },
    });

    written += chunk.length;
  }
  return written;
}

/** True when the spreadsheet still exists and we can still write to it. */
export async function sheetIsReachable(
  auth: OAuth2Client,
  spreadsheetId: string,
): Promise<boolean> {
  try {
    await google
      .sheets({ version: 'v4', auth })
      .spreadsheets.get({ spreadsheetId, fields: 'spreadsheetId' });
    return true;
  } catch {
    // Deleted by the user, or the grant no longer covers it → the caller
    // recreates rather than failing forever on a sheet that isn't there.
    return false;
  }
}
