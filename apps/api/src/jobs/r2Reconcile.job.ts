/**
 * R2 ↔ Postgres reconciliation — the drift audit nothing else performs.
 *
 * Two independent stores hold every file in this product: the bytes live in R2
 * and the truth about them lives in Postgres. Nothing keeps them in step
 * transactionally, and there is no way to make it: `uploadStream` puts the
 * object and a separate statement writes the row, so a worker that dies between
 * them leaves drift in one of two directions.
 *
 *   ORPHAN   an object in R2 that no live row claims. Cost: storage that is
 *            paid for and accounted to nobody. Created by a crash after the PUT
 *            and before the INSERT, by a purge that deleted the row but failed
 *            on the object, and by any partial-upload cleanup that itself
 *            failed.
 *   MISSING  a row whose object is not there. Cost: a file the dashboard lists,
 *            offers a download button for, and 404s on — the worse of the two,
 *            because it is user-visible and looks like data loss (it IS data
 *            loss; this only makes it honest).
 *
 * ── NOTHING IS EVER DELETED FROM R2 HERE ───────────────────────────────────
 *
 * Orphans are REPORTED, never removed, and that is not timidity. The orphan set
 * is computed by subtracting every key the database knows about from every key
 * in the bucket — so a query that silently returns fewer rows than it should
 * (a PostgREST page cap, an unapplied migration, a table this file has not been
 * taught about) does not produce a small error. It produces a LARGE, confident
 * list of live user files to delete. A read-only report cannot destroy anything
 * when it is wrong; a sweeper can destroy everything. The daily `purge_deleted`
 * job already deletes objects, and it does so by walking ROWS — the safe
 * direction.
 *
 * `missing` DOES write: it flips files.status to 'error'. That is a
 * one-column correction on a row that is already broken, and it is what stops
 * the dashboard offering a download that cannot work.
 *
 * ── THE KEY UNIVERSE IS BIGGER THAN files.r2_key ───────────────────────────
 *
 * This is the part that makes the difference between a usable report and a
 * generator of thousands of false positives. `files` is not the only table that
 * owns R2 objects. The bucket also holds thumbnails, scan-temp pages, diary
 * photos, encrypted vault blobs and gift-box photos + voice clips, none of
 * which appear in files.r2_key. Subtracting only that one column would flag
 * every one of them as an orphan.
 *
 * So the KNOWN set is the union of every key-bearing column in the schema:
 *
 *   files.r2_key, files.thumbnail_key          spaces/…/files, spaces/…/thumbnails
 *   scan_pages.r2_key                          spaces/…/scan-temp
 *   diary_entries.image_key, .thumbnail_key    diary/…
 *   vault_files.r2_key                         vault/…
 *   legacy_box_photos.r2_key                   legacy-box/…
 *   legacy_boxes.audio_key                     legacy-box/…
 *
 * (task_files owns no key of its own — it is a junction onto `files`.)
 *
 * ADDING A NEW R2-BACKED FEATURE MEANS ADDING ITS COLUMN TO KEY_SOURCES BELOW.
 * A missed one shows up as a block of orphans with a recognisable prefix, which
 * is annoying but harmless — the read-only posture above is what buys that
 * safety.
 *
 * ── MISSING is scoped narrowly on purpose ──────────────────────────────────
 *
 * Only `files` rows are checked for missing objects, because `files.status` is
 * the only place there is an 'error' state to write. And within `files`, rows
 * still in 'pending'/'processing' are EXCLUDED: those legitimately have a row
 * before they have an object — that is the normal upload sequence, not drift.
 * Flipping an in-flight upload to 'error' would break working uploads on every
 * run. `purged_at IS NULL` excludes tombstones, whose objects are deliberately
 * gone.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { S3Client } from '@aws-sdk/client-s3';
import { listR2Keys, listingWasTruncated } from '../services/r2.service';

export interface R2ReconciliationResult {
  /** Objects in R2 that no table claims. REPORTED ONLY — never deleted. */
  orphans: string[];
  /** files rows whose object is gone. Each has been flipped to status='error'. */
  missing: string[];
  /** Human-readable one-liner for the audit row and the admin page. */
  summary: string;
}

/**
 * PostgREST caps an unbounded select at 1000 rows, so every key column is read
 * in explicit pages. 1000 is its own page size; the cap below bounds a runaway.
 */
const DB_PAGE = 1000;
const DB_MAX_PAGES = 500; // 500k keys per column — far past this product's size

/**
 * The report is capped so a first run against a drifted bucket does not push a
 * multi-megabyte JSON body through the admin API. The COUNTS in `summary` are
 * always the true totals; only the listed samples are truncated.
 */
const REPORT_CAP = 500;

/** Every table+column pair that owns an R2 object key. See the header. */
const KEY_SOURCES: { table: string; columns: string[] }[] = [
  { table: 'files', columns: ['r2_key', 'thumbnail_key'] },
  { table: 'scan_pages', columns: ['r2_key'] },
  { table: 'diary_entries', columns: ['image_key', 'thumbnail_key'] },
  { table: 'vault_files', columns: ['r2_key'] },
  { table: 'legacy_box_photos', columns: ['r2_key'] },
  { table: 'legacy_boxes', columns: ['audio_key'] },
];

/**
 * Read one table's key columns, paged, into `into`.
 *
 * A table that does not exist (a migration not yet applied on this
 * environment) is LOGGED AND SKIPPED rather than thrown, and the caller is told
 * — because a skipped source is precisely a source of false orphans, and
 * `degraded` below is what stops those being reported.
 */
async function collectKeys(
  supabase: SupabaseClient,
  table: string,
  columns: string[],
  into: Set<string>,
): Promise<{ ok: boolean }> {
  const select = columns.join(', ');
  try {
    for (let page = 0; page < DB_MAX_PAGES; page += 1) {
      const { data, error } = await supabase
        .from(table)
        .select(select)
        .range(page * DB_PAGE, page * DB_PAGE + DB_PAGE - 1);
      if (error) throw error;
      const rows = (data ?? []) as unknown as Record<string, string | null>[];
      for (const row of rows) {
        for (const col of columns) {
          const key = row[col];
          if (key) into.add(key);
        }
      }
      if (rows.length < DB_PAGE) return { ok: true };
    }
    console.warn(`[r2-reconcile] ${table} hit the ${DB_MAX_PAGES}-page cap — key set is incomplete`);
    return { ok: false };
  } catch (err) {
    console.error(`[r2-reconcile] could not read ${table}.{${select}}:`, err);
    return { ok: false };
  }
}

/**
 * Walk the bucket and the database, report drift, and correct the one direction
 * that is safe to correct.
 *
 * Never throws on a per-table read failure — it degrades instead, and a
 * degraded run reports NO orphans (see the header). A failure to LIST R2 at all
 * does throw, because there is no partial answer to give: the job fails, BullMQ
 * records it, and the admin sees it on the status endpoint.
 */
export async function runR2Reconciliation(
  supabase: SupabaseClient,
  r2: S3Client,
): Promise<R2ReconciliationResult> {
  const startedAt = Date.now();

  // 1. Everything in the bucket.
  const r2KeyList = await listR2Keys(r2);
  const r2Keys = new Set(r2KeyList);
  const listingTruncated = listingWasTruncated(r2KeyList.length);

  // 2. Every key any table claims. `degraded` goes true the moment one source
  //    could not be read in full.
  const knownKeys = new Set<string>();
  let degraded = listingTruncated;
  for (const source of KEY_SOURCES) {
    const { ok } = await collectKeys(supabase, source.table, source.columns, knownKeys);
    if (!ok) degraded = true;
  }

  // 3. The files rows that a MISSING object would make a lie. Narrower than the
  //    known-key set above — see the header on why status and purged_at matter.
  const liveFileKeys = new Set<string>();
  const filesOk = await collectLiveFileKeys(supabase, liveFileKeys);
  if (!filesOk) degraded = true;

  // 4. orphans = in R2, claimed by nothing. Suppressed entirely on a degraded
  //    run: an incomplete known-set turns live user files into "orphans", and a
  //    list an admin cannot trust is worse than no list.
  const orphanAll: string[] = [];
  if (!degraded) {
    for (const key of r2Keys) {
      if (!knownKeys.has(key)) orphanAll.push(key);
    }
  }

  // 5. missing = a live files row with no object behind it.
  const missingAll: string[] = [];
  for (const key of liveFileKeys) {
    if (!r2Keys.has(key)) missingAll.push(key);
  }

  // 6. The one write. Batched by key rather than one statement per row: an
  //    `in` filter of 200 keys is one indexed UPDATE, and a run that finds
  //    hundreds of missing objects should not be hundreds of round trips.
  //    Each batch is independent — one failure does not abandon the rest,
  //    because marking SOME broken files correctly beats marking none.
  let marked = 0;
  const MARK_BATCH = 200;
  for (let i = 0; i < missingAll.length; i += MARK_BATCH) {
    const batch = missingAll.slice(i, i + MARK_BATCH);
    try {
      const { error } = await supabase
        .from('files')
        .update({ status: 'error', updated_at: new Date().toISOString() })
        .in('r2_key', batch);
      if (error) throw error;
      marked += batch.length;
    } catch (err) {
      console.error(`[r2-reconcile] could not mark ${batch.length} missing files as error:`, err);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const summary = degraded
    ? `DEGRADED run — one or more key sources could not be read in full, so ORPHANS ARE NOT REPORTED. ` +
      `Scanned ${r2Keys.size} R2 objects in ${elapsedMs} ms; ${missingAll.length} missing objects found, ` +
      `${marked} rows marked status=error.`
    : `Scanned ${r2Keys.size} R2 objects against ${knownKeys.size} known keys in ${elapsedMs} ms. ` +
      `${orphanAll.length} orphan objects (reported only, nothing deleted); ` +
      `${missingAll.length} missing objects, ${marked} rows marked status=error.`;

  console.log(`[r2-reconcile] ${summary}`);

  return {
    // Capped for transport; the true counts are in `summary`.
    orphans: orphanAll.slice(0, REPORT_CAP),
    missing: missingAll.slice(0, REPORT_CAP),
    summary,
  };
}

/**
 * files.r2_key for rows that SHOULD have an object right now.
 *
 * Excludes purged tombstones (object deliberately gone) and rows still in
 * 'pending'/'processing' (object not written yet — that is the normal upload
 * sequence, not drift). Soft-deleted rows are INCLUDED: their objects survive
 * until the retention window closes, so a missing one is real drift.
 */
async function collectLiveFileKeys(supabase: SupabaseClient, into: Set<string>): Promise<boolean> {
  try {
    for (let page = 0; page < DB_MAX_PAGES; page += 1) {
      const { data, error } = await supabase
        .from('files')
        .select('r2_key')
        .is('purged_at', null)
        .not('status', 'in', '("pending","processing")')
        .range(page * DB_PAGE, page * DB_PAGE + DB_PAGE - 1);
      if (error) throw error;
      const rows = (data ?? []) as unknown as { r2_key: string | null }[];
      for (const row of rows) {
        if (row.r2_key) into.add(row.r2_key);
      }
      if (rows.length < DB_PAGE) return true;
    }
    console.warn('[r2-reconcile] files hit the page cap — missing-object check is incomplete');
    return false;
  } catch (err) {
    console.error('[r2-reconcile] could not read files.r2_key:', err);
    return false;
  }
}
