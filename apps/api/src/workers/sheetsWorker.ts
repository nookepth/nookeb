import { Worker, type Job } from 'bullmq';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { SHEETS_QUEUE, type SheetsJob, type SheetsSyncJob } from '@nookeb/shared';
import { createClient } from '@supabase/supabase-js';
import { config } from '../config';
import { createRedis } from '../plugins/redis';
import { effectiveDeadline, getTaskWithDetails, type TaskWithDetails } from '../services/task.service';
import {
  authorizedClient,
  createSheet,
  getIntegration,
  isAuthError,
  isGoogleSheetsConfigured,
  recordSyncResult,
  sheetIsReachable,
  syncTaskToSheet,
  type SheetTaskRow,
} from '../services/google-sheets.service';

dayjs.extend(utc);
dayjs.extend(timezone);

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

const BANGKOK_TZ = 'Asia/Bangkok';

// Service-role client, same as the other workers (they each build their own —
// there is no Fastify instance to take `app.supabase` from out here).
const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const d = dayjs(iso);
  return d.isValid() ? d.tz(BANGKOK_TZ).format('DD/MM/YYYY HH:mm') : '';
}

/**
 * Newest activity on the task — same derivation as the .xlsx export: there is
 * no updated_at column, so it comes from the stamps that already exist.
 */
function resolveUpdatedAt(task: TaskWithDetails): string | null {
  const stamps = task.items
    .flatMap((i) => [
      i.submitted_at,
      i.rejected_at,
      ...i.assignees.flatMap((a) => [a.done_at, a.accepted_at]),
    ])
    .filter((s): s is string => s !== null);
  if (stamps.length === 0) return task.created_at;
  return stamps.reduce((a, b) => (new Date(a).getTime() >= new Date(b).getTime() ? a : b));
}

/**
 * One task → one sheet row. A multi task is FLATTENED here (unlike the .xlsx
 * export, which gets a row per item): the sheet is a live mirror keyed by task
 * id, and one row per task is what keeps "find the row, update it" a single
 * cheap operation. The per-item detail stays in รายละเอียด.
 */
function toSheetRow(task: TaskWithDetails, createdBy: string, deleted: boolean): SheetTaskRow {
  const assignees = [
    ...new Set(
      task.items.flatMap((i) => i.assignees.map((a) => a.display_name || 'สมาชิก')),
    ),
  ];
  const description =
    task.type === 'multi'
      ? task.items.map((i, n) => `${n + 1}. ${i.title}`).join('\n')
      : (task.items[0]?.description ?? '');
  const deadline =
    task.global_deadline ?? (task.items[0] ? effectiveDeadline(task, task.items[0]) : null);

  return {
    taskId: task.id,
    title: task.title,
    description,
    type: task.type,
    deadline: formatWhen(deadline),
    createdBy,
    assignees: assignees.join(', '),
    status: task.status,
    updatedAt: formatWhen(resolveUpdatedAt(task)),
    deleted,
  };
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
    .select('id, display_name')
    .eq('line_user_id', task.created_by_line_uid)
    .maybeSingle();
  const creatorRow = creator as { id: string; display_name: string | null } | null;
  if (!creatorRow) return; // creator never logged into the web app

  const integration = await getIntegration(supabase, creatorRow.id);
  if (!integration) return; // not connected — the overwhelmingly common case

  try {
    const auth = await authorizedClient(creatorRow.id, integration.encrypted_token);

    // Create the sheet on first sync (and re-create if the user deleted it) —
    // doing it lazily means connecting Google costs zero API calls, and a
    // deleted sheet heals itself on the next task change instead of failing
    // every sync from then on.
    let sheetId = integration.sheet_id;
    if (!sheetId || !(await sheetIsReachable(auth, sheetId))) {
      const created = await createSheet(auth);
      sheetId = created.sheetId;
      await recordSyncResult(supabase, creatorRow.id, {
        sheetId: created.sheetId,
        sheetUrl: created.url,
      });
    }

    const deleted = data.action === 'delete' || task.status === 'cancelled';
    await syncTaskToSheet(
      auth,
      sheetId,
      toSheetRow(task, creatorRow.display_name ?? 'ไม่ทราบชื่อ', deleted),
    );
    await recordSyncResult(supabase, creatorRow.id, { error: null });
  } catch (err) {
    if (isAuthError(err)) {
      console.warn(`[sheets] auth failed for user ${creatorRow.id} — user must reconnect`);
      await recordSyncResult(supabase, creatorRow.id, {
        error: 'การเชื่อมต่อ Google หมดอายุ กดเชื่อมต่อใหม่อีกครั้งน้า',
      }).catch(() => {});
      return; // NOT retryable
    }
    await recordSyncResult(supabase, creatorRow.id, {
      error: 'sync ล่าสุดไม่สำเร็จ หนูจะลองใหม่ให้เองน้า',
    }).catch(() => {});
    throw err; // retryable — BullMQ backs off
  }
}

export function createSheetsWorker(): Worker<SheetsJob> {
  const worker = new Worker<SheetsJob>(SHEETS_QUEUE, processSheetsSync, {
    connection: createRedis(),
    // Low concurrency on purpose: Google's per-project quota is shared across
    // every user, and each sync is several API calls.
    concurrency: 3,
  });
  worker.on('failed', (job, err) => {
    console.error(`[sheets] job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err);
  });
  return worker;
}
