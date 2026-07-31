import { google } from 'googleapis';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getTaskWithDetails, type TaskWithDetails } from './task.service';
import { appendTaskRows, readSyncedTaskIds, type SheetTaskRow } from './google-sheets.service';
import { toSheetRows } from './sheets-row';
import { readHistoricalStamp, writeHistoricalStamp } from './sheets-workspace.service';

/**
 * Historical backfill — the one-time counterpart to the event-driven sync.
 *
 * WHY IT EXISTS. `enqueueSheetsSync` fires when a task CHANGES, so a user who
 * connects Google today gets a sheet that only ever learns about tasks they
 * touch from today on. Everything created before the connect stays invisible
 * until someone happens to edit it, which for a finished task is never.
 *
 * WHOSE TASKS. Tasks the user CREATED, and only those — the same rule the live
 * sync applies (sheetsWorker resolves the sheet from `created_by_line_uid`).
 * Backfilling `listTasksForUser` instead would pull in tasks they were merely
 * assigned to, filling the sheet with rows the live sync would never write or
 * update again — a report that silently goes stale is worse than one that
 * doesn't have the row.
 *
 * IDEMPOTENT BY CONSTRUCTION. The duplicate guard is the sheet's own รหัสงาน
 * column, read fresh on every run (see readSyncedTaskIds), so running the
 * backfill twice — or running it against a sheet the live sync has been
 * writing to for months — appends nothing it shouldn't. That is also what makes
 * it safe to expose as a "run it again" button rather than a one-shot.
 */

/** Same derivation as the other Google modules — see google-sheets.service.ts. */
type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

/**
 * Ceiling on one backfill run. Matches the .xlsx export's cap for the same
 * reason: each task costs four Supabase round-trips (getTaskWithDetails), and
 * an unbounded loop over a power user's history would hold a worker slot for
 * minutes and push Sheets' per-minute write quota. A user over the cap gets
 * their oldest 500 and can press the button again — the duplicate guard makes
 * the second run pick up where the first stopped.
 */
export const HISTORICAL_MAX_TASKS = 500;

/** How many getTaskWithDetails calls run at once. */
const DETAIL_CONCURRENCY = 8;

export interface HistoricalSyncResult {
  /** Rows appended by this run. */
  imported: number;
  /** Tasks already present in the sheet, left untouched. */
  skipped: number;
  /** Tasks considered (after the cap). */
  total: number;
}

/**
 * Pull every task this user has created into their spreadsheet.
 *
 * Takes an already-authorized client and a resolved spreadsheet id rather than
 * building them: the caller (the worker) has already had to create-or-heal the
 * sheet and check the integration, and re-doing that here would either
 * duplicate that logic or make this function untestable without a live OAuth
 * client.
 */
export async function historicalSync(
  supabase: SupabaseClient,
  auth: OAuth2Client,
  spreadsheetId: string,
  userId: string,
): Promise<HistoricalSyncResult> {
  const { data: user, error: userErr } = await supabase
    .from('users')
    .select('line_user_id, display_name')
    .eq('id', userId)
    .maybeSingle();
  if (userErr) throw userErr;
  const userRow = user as { line_user_id: string | null; display_name: string | null } | null;
  if (!userRow?.line_user_id) return { imported: 0, skipped: 0, total: 0 };

  // Oldest first, so ลำดับ reads chronologically down the sheet and a capped
  // run leaves the NEWEST tasks for the next press (they are the ones the live
  // sync is most likely to pick up on its own anyway).
  const { data: taskRows, error: taskErr } = await supabase
    .from('tasks')
    .select('id')
    .eq('created_by_line_uid', userRow.line_user_id)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(HISTORICAL_MAX_TASKS);
  if (taskErr) throw taskErr;

  const ids = ((taskRows ?? []) as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) {
    await stamp(auth, spreadsheetId, 0);
    return { imported: 0, skipped: 0, total: 0 };
  }

  // The duplicate guard: whatever is in column J right now, including rows the
  // live sync wrote and rows the add-on created (LOCAL-…). A multi task synced
  // BEFORE per-item rows existed sits in the sheet keyed by its bare task id,
  // so a task counts as present when EITHER its bare id or any of its item keys
  // is — the live sync upgrades that legacy row in place on the task's next
  // change, and appending item rows beside it here would duplicate it.
  const present = await readSyncedTaskIds(auth, spreadsheetId);
  const candidates = ids.filter((id) => !present.has(id));
  if (candidates.length === 0) {
    await stamp(auth, spreadsheetId, 0);
    return { imported: 0, skipped: ids.length, total: ids.length };
  }

  const createdBy = userRow.display_name ?? 'ไม่ทราบชื่อ';
  const rows: SheetTaskRow[] = [];
  let skippedAsPresent = ids.length - candidates.length;
  for (let i = 0; i < candidates.length; i += DETAIL_CONCURRENCY) {
    const batch = await Promise.all(
      candidates.slice(i, i + DETAIL_CONCURRENCY).map((id) => getTaskWithDetails(supabase, id)),
    );
    for (const task of batch) {
      if (!task) continue; // deleted between the id query and now
      // Per-ROW guard: a run that died halfway may have appended some of a
      // multi task's item rows — only the missing ones go in.
      const missingRows = toSheetRows(
        task as TaskWithDetails,
        createdBy,
        task.status === 'cancelled',
      ).filter((row) => !present.has(row.key));
      if (missingRows.length === 0) {
        skippedAsPresent += 1;
        continue;
      }
      rows.push(...missingRows);
    }
  }

  const imported = await appendTaskRows(auth, spreadsheetId, rows);
  await stamp(auth, spreadsheetId, imported);
  return { imported, skipped: skippedAsPresent, total: ids.length };
}

/**
 * Record the run. Never fatal: the rows are already in the sheet by this point,
 * and failing the job over a cosmetic marker would re-run an import that has
 * nothing left to import.
 */
async function stamp(auth: OAuth2Client, spreadsheetId: string, count: number): Promise<void> {
  try {
    await writeHistoricalStamp(auth, spreadsheetId, { at: new Date().toISOString(), count });
  } catch {
    // ignored — see above
  }
}

/** True when this spreadsheet has never been backfilled. */
export async function needsHistoricalSync(
  auth: OAuth2Client,
  spreadsheetId: string,
): Promise<boolean> {
  try {
    return (await readHistoricalStamp(auth, spreadsheetId)) === null;
  } catch {
    // Unreadable metadata → assume it HAS run. Re-running is harmless but costs
    // API calls; skipping only delays the backfill to the next manual press.
    return false;
  }
}
