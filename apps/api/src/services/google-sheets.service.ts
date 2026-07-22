import { google, type sheets_v4 } from 'googleapis';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TaskItemStatus, TaskType } from '@nookeb/shared';
import { config } from '../config';
import { decryptSecret, deriveSecretKey, encryptSecret, isVaultConfigured } from './vault-crypto';

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

const STATUS_LABEL: Record<TaskItemStatus, string> = {
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
  taskId: string;
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
    },
    { onConflict: 'user_id' },
  );
  if (error) throw error;
}

export async function getIntegration(
  supabase: SupabaseClient,
  userId: string,
): Promise<GoogleIntegrationRow | null> {
  const { data, error } = await supabase
    .from('google_integrations')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as GoogleIntegrationRow | null) ?? null;
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

/** True for the errors that mean "the user must reconnect", not "retry later". */
export function isAuthError(err: unknown): boolean {
  const e = err as { response?: { status?: number }; message?: string; code?: string | number };
  const status = e?.response?.status ?? (typeof e?.code === 'number' ? e.code : undefined);
  if (status === 401 || status === 403) return true;
  return /invalid_grant|invalid_client|unauthorized/i.test(String(e?.message ?? ''));
}

// ---- sheet creation + formatting ----

/** Create the user's sheet and apply the whole look in ONE batchUpdate. */
export async function createSheet(
  auth: OAuth2Client,
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
                  fontFamily: 'Arial',
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
 * Find a task's row by its hidden รหัสงาน cell. Reads only that ONE column, so
 * the request stays small no matter how long the sheet gets. Returns a 0-based
 * sheet row index, or null when the task has never been written (or the user
 * deleted its row — in which case it is simply appended again).
 */
async function findRow(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  taskId: string,
): Promise<number | null> {
  const column = String.fromCharCode(65 + TASK_ID_COLUMN); // 'J'
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${TAB_TITLE}!${column}:${column}`,
    majorDimension: 'COLUMNS',
  });
  const values = res.data.values?.[0] ?? [];
  const index = values.findIndex((v) => v === taskId);
  return index === -1 ? null : index;
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
    row.taskId,
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
            fontFamily: 'Arial',
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
 * Write one task into the sheet: update its existing row, or append a new one.
 * Idempotent — running it twice for the same task leaves one row.
 */
export async function syncTaskToSheet(
  auth: OAuth2Client,
  spreadsheetId: string,
  row: SheetTaskRow,
): Promise<void> {
  const sheets = google.sheets({ version: 'v4', auth });
  const [gid, existing] = await Promise.all([
    tabGid(sheets, spreadsheetId),
    findRow(sheets, spreadsheetId, row.taskId),
  ]);

  let rowIndex: number;
  if (existing !== null) {
    rowIndex = existing;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${TAB_TITLE}!A${rowIndex + 1}`,
      valueInputOption: 'RAW',
      // Keep the ลำดับ the row already has — renumbering every row on each sync
      // would rewrite the whole sheet for one task change.
      requestBody: { values: [rowValues(row, rowIndex)] },
    });
  } else {
    const appended = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${TAB_TITLE}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [rowValues(row, 0)] },
    });
    // updatedRange looks like "'งานของฉัน'!A7:J7" — take the first row number.
    const match = /![A-Z]+(\d+)/.exec(appended.data.updates?.updatedRange ?? '');
    rowIndex = match ? Number(match[1]) - 1 : HEADER_ROWS;
    // Now that the row exists, stamp its ลำดับ (= its position under the header).
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${TAB_TITLE}!A${rowIndex + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[String(rowIndex)]] },
    });
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [rowFormatRequest(gid, rowIndex, row)] },
  });
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
