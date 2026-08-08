import { Worker, type Job } from 'bullmq';
import {
  SHEETS_QUEUE,
  type SheetsHistoricalJob,
  type SheetsJob,
  type SheetsSyncJob,
} from '@nookeb/shared';
import { createClient } from '@supabase/supabase-js';
import { config } from '../config';
import { createRedis } from '../plugins/redis';
import { getTaskWithDetails } from '../services/task.service';
import {
  authorizedClient,
  createSheet,
  describeGoogleError,
  getIntegration,
  isAuthError,
  isGoogleSheetsConfigured,
  isServiceConfigError,
  recordSyncResult,
  sheetIsReachable,
  syncTaskToSheet,
  type GoogleIntegrationRow,
} from '../services/google-sheets.service';
import { toSheetRows } from '../services/sheets-row';
import { ensureWorkspace } from '../services/sheets-workspace.service';
import { historicalSync, needsHistoricalSync } from '../services/sheets-historical.service';
import { enqueueHistoricalSync } from '../services/sheetsQueue';
// planAllows still serves `performance_report` below — only the two
// `google_sheets` checks moved to resolveSheetsAccess (migration 062).
import { planAllows } from '../middleware/planGuard';
import { resolveSheetsAccess } from '../services/sheets-trial.service';

/**
 * Google Sheets sync worker (migration 046) — mirrors one task into its owner's
 * spreadsheet. Runs on its own queue so a Google outage can only back up here.
 *
 * Which sheet? The task CREATOR's. A task has one owner and one report; syncing
 * into every assignee's sheet as well would multiply API calls by the team size
 * and put other people's group tasks into a personal report they never asked
 * for. Assignees who want the data have the LIFF and the .xlsx export.
 *
 * Failure policy, and the distinction that matters:
 *   - no integration / not configured / no task  → COMPLETE silently. These are
 *     normal states, not errors; throwing would burn retries forever on users
 *     who simply never connected Google.
 *   - auth error (revoked grant, bad client)     → record last_error and
 *     COMPLETE. Retrying cannot fix it; the dashboard tells the user to
 *     reconnect. Throwing here would retry 3× and then look identical to an
 *     outage in the logs.
 *   - anything else (5xx, rate limit, network)   → THROW so BullMQ retries with
 *     the queue's long backoff.
 */

// Service-role client, same as the other workers (they each build their own —
// there is no Fastify instance to take `app.supabase` from out here).
const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/**
 * Deep link the sheet's "🔄 sync ประวัติงาน" button points at. It goes to the
 * WEB dashboard, not to the API: a Sheets HYPERLINK can only issue a GET from
 * the user's browser, and the browser holds the session cookie on the web
 * origin, not the API host (see routes/integrations.ts). The dashboard page
 * reads the query and POSTs the request properly.
 */
const HISTORICAL_SYNC_URL = `${config.WEB_URL}/dashboard/settings?sync=historical`;

/**
 * Last time each spreadsheet's layout was verified. In-process on purpose: this
 * is a cache, not a lock — the worst case after a restart is one extra
 * spreadsheets.get per sheet, and ensureWorkspace is itself idempotent.
 */
const layoutCheckedAt = new Map<string, number>();
const LAYOUT_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Spreadsheets already known to carry a backfill marker. Same rationale as
 * layoutCheckedAt — a cache, not a lock. Without it every single task sync
 * would spend one spreadsheets.get re-learning a fact that never changes back;
 * a restart just costs one extra call per sheet.
 */
const historicalDone = new Set<string>();

/**
 * Keep the workspace layout current, without ever failing a sync over it. A
 * task row reaching the sheet matters more than the dashboard around it being
 * one version behind, so every error here is swallowed and retried later.
 */
async function ensureWorkspaceThrottled(
  auth: Parameters<typeof ensureWorkspace>[0],
  spreadsheetId: string,
  userId: string,
): Promise<void> {
  const last = layoutCheckedAt.get(spreadsheetId) ?? 0;
  if (Date.now() - last < LAYOUT_CHECK_TTL_MS) return;
  try {
    // §16 — the per-person performance tab is premium-only. Today only premium
    // users reach the sync at all (§15 gates the whole integration), so this is
    // belt-and-braces — but it is stated EXPLICITLY rather than inherited from
    // the Sheets gate, so opening Sheets to Pro later cannot silently ship the
    // performance report with it.
    const { data: planRow } = await supabase
      .from('users')
      .select('plan')
      .eq('id', userId)
      .maybeSingle();

    const rebuilt = await ensureWorkspace(auth, spreadsheetId, {
      syncUrl: HISTORICAL_SYNC_URL,
      performanceReport: planAllows(planRow?.plan as string | null, 'performance_report'),
    });
    layoutCheckedAt.set(spreadsheetId, Date.now());
    if (rebuilt) console.log(`[sheets] workspace layout built for ${spreadsheetId}`);
  } catch (err) {
    console.warn(`[sheets] workspace layout skipped: ${describeGoogleError(err).message}`);
  }
}

/**
 * Resolve (creating or healing where needed) the spreadsheet a user's rows go
 * into. Shared by both job kinds so the create-if-missing, re-create-if-deleted
 * and layout-upgrade rules can only ever exist once.
 */
async function resolveSheet(
  userId: string,
  integration: GoogleIntegrationRow,
): Promise<{ auth: Awaited<ReturnType<typeof authorizedClient>>; sheetId: string }> {
  const auth = await authorizedClient(userId, integration.encrypted_token);

  // Create the sheet on first sync (and re-create if the user deleted it) —
  // doing it lazily means connecting Google costs zero API calls, and a
  // deleted sheet heals itself on the next task change instead of failing
  // every sync from then on.
  let sheetId = integration.sheet_id;
  if (!sheetId || !(await sheetIsReachable(auth, sheetId))) {
    const created = await createSheet(auth, { syncUrl: HISTORICAL_SYNC_URL });
    sheetId = created.sheetId;
    await recordSyncResult(supabase, userId, {
      sheetId: created.sheetId,
      sheetUrl: created.url,
    });
  }

  // Upgrade path for sheets created before the current layout. ensureWorkspace
  // no-ops once the version matches, and the in-process cache keeps even that
  // check off the hot path — a sheet is verified at most once every 6 hours.
  await ensureWorkspaceThrottled(auth, sheetId, userId);
  return { auth, sheetId };
}

export async function processSheetsSync(job: Job<SheetsJob>): Promise<void> {
  const data = job.data as SheetsSyncJob;
  if (!isGoogleSheetsConfigured()) return;

  const task = await getTaskWithDetails(supabase, data.taskId);
  // Hard-gone task (soft-deleted shell from a failed create): nothing to mirror.
  if (!task) return;

  // Resolve the creator → their nookeb user → their integration.
  const { data: creator } = await supabase
    .from('users')
    .select('id, display_name, plan')
    .eq('line_user_id', task.created_by_line_uid)
    .maybeSingle();
  const creatorRow = creator as
    | { id: string; display_name: string | null; plan: string | null }
    | null;
  if (!creatorRow) return; // creator never logged into the web app

  // §15 — PREMIUM or a live หนูเก็บลองงาน trial, re-checked at DELIVERY time,
  // not just at connect time. A user who downgrades keeps their
  // google_integrations row (their spreadsheet is theirs, and deleting the
  // credential on downgrade would make re-upgrading a full re-consent). Without
  // this check their sheet would keep receiving mirrored tasks on a plan that
  // does not include the feature.
  //
  // THIS IS THE CHECK THAT MAKES THE TRIAL ACTUALLY DO ANYTHING. It used to be
  // `planAllows(creatorRow.plan, 'google_sheets')`, which sees only the plan: a
  // trial user would complete OAuth, see "เชื่อมต่อแล้ว", and then have every
  // single sync silently skipped here — a failure that looks exactly like
  // success from the dashboard. A route-level guard cannot cover this path;
  // nothing in a BullMQ job has a request to guard.
  //
  // It is also the trial's cutoff on the delivery side: `expires_at` is
  // compared against the current instant per job, so a sync queued during the
  // trial and executed after it stands down here.
  const creatorAccess = await resolveSheetsAccess(supabase, creatorRow.id);
  if (!creatorAccess.allowed) return;

  const integration = await getIntegration(supabase, creatorRow.id);
  if (!integration) return; // not connected — the overwhelmingly common case

  try {
    const { auth, sheetId } = await resolveSheet(creatorRow.id, integration);

    const deleted = data.action === 'delete' || task.status === 'cancelled';
    await syncTaskToSheet(
      auth,
      sheetId,
      toSheetRows(task, creatorRow.display_name ?? 'ไม่ทราบชื่อ', deleted),
    );
    await recordSyncResult(supabase, creatorRow.id, { error: null });

    // First time this spreadsheet has ever been written to? Everything the user
    // created BEFORE they connected is still missing from it, so pull it in.
    // Queued as its own job rather than run inline: a backfill is minutes of
    // work and this job's contract is "one task reaches the sheet quickly".
    if (!historicalDone.has(sheetId) && (await needsHistoricalSync(auth, sheetId))) {
      enqueueHistoricalSync(creatorRow.id);
    }
  } catch (err) {
    // Log the REAL Google error (status + reason + message, never a token — see
    // describeGoogleError) so a disabled API vs a revoked grant vs a mismatched
    // OAuth client are distinguishable in the logs instead of all reading as a
    // generic failure. This is what makes "why is Sheets broken?" answerable.
    const info = describeGoogleError(err);
    console.warn(
      `[sheets] sync failed for user ${creatorRow.id}: ` +
        `status=${info.status ?? '-'} reason=${info.reason ?? '-'} msg=${info.message}`,
    );

    if (isServiceConfigError(err)) {
      // The Sheets/Drive API is disabled for the project (or unreachable). The
      // USER can't fix this by reconnecting — an operator must enable the API —
      // so say so honestly and let BullMQ retry, so it self-heals once enabled.
      await recordSyncResult(supabase, creatorRow.id, {
        error: 'ระบบ Google Sheets ยังไม่พร้อมชั่วคราว หนูจะลองใหม่ให้เองน้า',
      }).catch(() => {});
      throw err; // retryable — recovers automatically once the API is enabled
    }
    if (isAuthError(err)) {
      await recordSyncResult(supabase, creatorRow.id, {
        error: 'การเชื่อมต่อ Google หมดอายุ กดเชื่อมต่อใหม่อีกครั้งน้า',
      }).catch(() => {});
      return; // NOT retryable — a revoked/expired grant needs a fresh consent
    }
    await recordSyncResult(supabase, creatorRow.id, {
      error: 'sync ล่าสุดไม่สำเร็จ หนูจะลองใหม่ให้เองน้า',
    }).catch(() => {});
    throw err; // retryable — BullMQ backs off
  }
}

/**
 * Backfill every task the user created before their sheet existed.
 *
 * Same failure policy as processSheetsSync, deliberately: an auth error stands
 * the job down (retrying a revoked grant is pointless), everything else throws
 * so BullMQ retries. A retry is safe — the sheet's own รหัสงาน column is the
 * duplicate guard, so a run that died halfway simply appends the remainder.
 */
export async function processSheetsHistorical(job: Job<SheetsJob>): Promise<void> {
  const { userId } = job.data as SheetsHistoricalJob;
  if (!isGoogleSheetsConfigured()) return;

  // §15 — same delivery-time entitlement check as processSheetsSync: a backfill
  // queued before a downgrade (or before a trial ran out) must not run after
  // it. The expiry sweep also drops any waiting job for the user, but that is
  // best-effort tidying — this is the boundary.
  const access = await resolveSheetsAccess(supabase, userId);
  if (!access.allowed) return;

  const integration = await getIntegration(supabase, userId);
  if (!integration) return; // disconnected between the press and the job

  try {
    const { auth, sheetId } = await resolveSheet(userId, integration);
    const result = await historicalSync(supabase, auth, sheetId, userId);
    historicalDone.add(sheetId);
    console.log(
      `[sheets] historical sync for user ${userId}: ` +
        `imported=${result.imported} skipped=${result.skipped} total=${result.total}`,
    );
    await recordSyncResult(supabase, userId, { error: null });
  } catch (err) {
    const info = describeGoogleError(err);
    console.warn(
      `[sheets] historical sync failed for user ${userId}: ` +
        `status=${info.status ?? '-'} reason=${info.reason ?? '-'} msg=${info.message}`,
    );
    if (isAuthError(err)) {
      await recordSyncResult(supabase, userId, {
        error: 'การเชื่อมต่อ Google หมดอายุ กดเชื่อมต่อใหม่อีกครั้งน้า',
      }).catch(() => {});
      return;
    }
    await recordSyncResult(supabase, userId, {
      error: 'ดึงประวัติงานเก่าไม่สำเร็จ หนูจะลองใหม่ให้เองน้า',
    }).catch(() => {});
    throw err;
  }
}

/** One queue, two job kinds — dispatch on the payload's discriminant. */
export async function processSheetsJob(job: Job<SheetsJob>): Promise<void> {
  if (job.data.type === 'sheets_historical') return processSheetsHistorical(job);
  return processSheetsSync(job);
}

export function createSheetsWorker(): Worker<SheetsJob> {
  const worker = new Worker<SheetsJob>(SHEETS_QUEUE, processSheetsJob, {
    connection: createRedis(),
    // Low concurrency on purpose: Google's per-project quota is shared across
    // every user, and each sync is several API calls.
    concurrency: 3,
    // drainDelay is in SECONDS (default 5). This queue has NO repeatable/delayed
    // scheduler job, so blockUntil stays 0 and drainDelay DOES take effect: an
    // idle sheets worker blocks ~indefinitely on BZPOPMIN and polls near-zero,
    // waking instantly when enqueueSheetsSync adds a job. This is the queue that
    // actually benefits from a high drainDelay. Raised 20s → 60s: no pickup
    // latency cost (an added job wakes the blocked worker via the marker), fewer
    // idle re-poll commands.
    drainDelay: 60000,
    // See upload.worker: halve the stalled-check EVALSHA; longer active-processing
    // lock renewal (no idle effect).
    stalledInterval: 60_000,
    lockDuration: 60_000,
  });
  worker.on('failed', (job, err) => {
    console.error(`[sheets] job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err);
  });
  return worker;
}
