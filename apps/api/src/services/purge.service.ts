import type { SupabaseClient } from '@supabase/supabase-js';
import type { S3Client } from '@aws-sdk/client-s3';
import { adjustStorageUsed } from './file.service';
import { deleteObject } from './r2.service';
import { deleteScanTempObjects } from './scan.service';

export interface PurgeResult {
  cutoff: string;
  scanned: number;
  objectsDeleted: number;
  errors: number;
  /** file ids whose R2 objects were removed (row kept as tombstone) */
  purgedFileIds: string[];
}

/** The columns a file purge needs — used by both the daily job and manual trash purge. */
export interface PurgeFileRow {
  id: string;
  r2_key: string;
  thumbnail_key: string | null;
}

/**
 * Purge a specific set of file rows: delete their R2 objects (original +
 * thumbnail), then stamp `purged_at` and redact user content on the rows whose
 * R2 deletes ALL succeeded. Rows are kept as tombstones (rule 6). Shared by
 * the daily purge job and the trash routes (ลบถาวร / ล้างถังขยะ). Idempotent:
 * deleting an already-gone object is a no-op, so re-running is safe.
 *
 * Names and OCR text ARE the file's content (OCR is literally the text inside
 * the image), so "deleted" must cover them too; id/space_id/file_size/
 * uploaded_by/deleted_at/purged_at are kept — they carry no content and are
 * needed for quota accounting and the audit trail. If an object delete failed
 * we keep the metadata intact so a later run can retry against a consistent row.
 */
export async function purgeFileRows(
  supabase: SupabaseClient,
  r2: S3Client,
  rows: PurgeFileRow[],
): Promise<{ objectsDeleted: number; errors: number; purgedFileIds: string[] }> {
  const result = { objectsDeleted: 0, errors: 0, purgedFileIds: [] as string[] };

  for (const row of rows) {
    const keys = [row.r2_key, row.thumbnail_key].filter((k): k is string => Boolean(k));
    let ok = true;
    for (const key of keys) {
      try {
        await deleteObject(r2, key);
        result.objectsDeleted += 1;
      } catch {
        result.errors += 1;
        ok = false;
      }
    }
    if (ok) result.purgedFileIds.push(row.id);
  }

  if (result.purgedFileIds.length > 0) {
    const { error: markErr } = await supabase
      .from('files')
      .update({
        purged_at: new Date().toISOString(),
        ocr_text: null,
        original_name: '[deleted]',
        display_name: '[deleted]',
      })
      .in('id', result.purgedFileIds);
    if (markErr) throw markErr;
  }

  return result;
}

/**
 * Delete the R2 objects (original + thumbnail) of files that were soft-deleted
 * past their retention window. The DB row is kept as a tombstone — the project
 * rule forbids hard-deleting files rows. Idempotent: deleting an already-gone
 * object is a no-op, so re-running is safe.
 *
 * Retention is PLAN-AWARE (trash bin, migration 032): free-plan (or ownerless)
 * files use `retentionDays`; files uploaded by a pro/team-plan user use
 * `retentionDaysPro` (defaults to `retentionDays` when omitted, restoring the
 * old single-cutoff behavior). The reported `cutoff` is the free-tier one.
 *
 * `apply=false` (default) only reports what would be deleted.
 */
export async function purgeDeletedFiles(
  supabase: SupabaseClient,
  r2: S3Client,
  opts: { retentionDays: number; retentionDaysPro?: number; apply: boolean },
): Promise<PurgeResult> {
  const dayMs = 24 * 60 * 60 * 1000;
  const retentionDaysPro = opts.retentionDaysPro ?? opts.retentionDays;
  const freeCutoff = new Date(Date.now() - opts.retentionDays * dayMs).toISOString();
  const proCutoff = new Date(Date.now() - retentionDaysPro * dayMs).toISOString();
  // Query with the LATER cutoff (shorter retention) — a superset of both plans'
  // eligible rows — then apply each row's own plan cutoff below.
  const queryCutoff = freeCutoff > proCutoff ? freeCutoff : proCutoff;

  // `uploader` embeds the users row via the files.uploaded_by FK — null for
  // ownerless (legacy / non-member group) files, which get the free retention.
  const { data, error } = await supabase
    .from('files')
    .select('id, r2_key, thumbnail_key, deleted_at, uploader:users!uploaded_by(plan)')
    .not('deleted_at', 'is', null)
    .is('purged_at', null) // skip rows whose R2 objects are already gone
    .lt('deleted_at', queryCutoff);
  if (error) throw error;

  const rows = ((data ?? []) as unknown[])
    .map((r) => r as PurgeFileRow & { deleted_at: string; uploader: { plan: string | null } | null })
    .filter((row) => {
      const isPro = row.uploader?.plan === 'pro' || row.uploader?.plan === 'team';
      return row.deleted_at < (isPro ? proCutoff : freeCutoff);
    });

  const result: PurgeResult = {
    cutoff: freeCutoff,
    scanned: rows.length,
    objectsDeleted: 0,
    errors: 0,
    purgedFileIds: [],
  };

  if (!opts.apply) {
    for (const row of rows) {
      result.purgedFileIds.push(row.id);
      result.objectsDeleted += [row.r2_key, row.thumbnail_key].filter(Boolean).length;
    }
    return result;
  }

  const applied = await purgeFileRows(supabase, r2, rows);
  result.objectsDeleted = applied.objectsDeleted;
  result.errors = applied.errors;
  result.purgedFileIds = applied.purgedFileIds;
  return result;
}

export interface DiaryPurgeResult {
  cutoff: string;
  scanned: number;
  objectsDeleted: number;
  errors: number;
}

/**
 * Diary counterpart of purgeDeletedFiles (migration 028): remove the R2 objects
 * (photo + thumbnail) of diary entries soft-deleted more than `retentionDays`
 * ago, stamp `purged_at`, and redact the caption (it IS the entry's content).
 * Rows are kept as tombstones. Idempotent for the same reasons as the files
 * purge. `apply=false` only reports.
 */
export async function purgeDeletedDiaryEntries(
  supabase: SupabaseClient,
  r2: S3Client,
  opts: { retentionDays: number; apply: boolean },
): Promise<DiaryPurgeResult> {
  const cutoff = new Date(Date.now() - opts.retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('diary_entries')
    .select('id, image_key, thumbnail_key')
    .not('deleted_at', 'is', null)
    .is('purged_at', null)
    .lt('deleted_at', cutoff);
  if (error) throw error;

  const rows = (data ?? []) as { id: string; image_key: string; thumbnail_key: string | null }[];
  const result: DiaryPurgeResult = { cutoff, scanned: rows.length, objectsDeleted: 0, errors: 0 };
  const purgedIds: string[] = [];

  for (const row of rows) {
    const keys = [row.image_key, row.thumbnail_key].filter((k): k is string => Boolean(k));
    if (!opts.apply) {
      result.objectsDeleted += keys.length;
      continue;
    }
    let ok = true;
    for (const key of keys) {
      try {
        await deleteObject(r2, key);
        result.objectsDeleted += 1;
      } catch {
        result.errors += 1;
        ok = false;
      }
    }
    if (ok) purgedIds.push(row.id);
  }

  if (opts.apply && purgedIds.length > 0) {
    const { error: markErr } = await supabase
      .from('diary_entries')
      .update({ purged_at: new Date().toISOString(), caption: '[deleted]' })
      .in('id', purgedIds);
    if (markErr) throw markErr;
  }

  return result;
}

export interface VaultPurgeResult {
  cutoff: string;
  scanned: number;
  objectsDeleted: number;
  rowsDeleted: number;
  /** bytes refunded to users.storage_used for the rows this run hard-deleted */
  bytesRefunded: number;
  errors: number;
}

/**
 * Vault counterpart (migration 031): after the retention window, delete the R2
 * ciphertext of soft-deleted vault files AND hard-delete the row. The hard
 * delete is a deliberate, vault-scoped deviation from rule 6's tombstones —
 * a vault row's filename is itself sensitive content, so nothing needs the
 * tombstone. The row is only removed once its R2 delete succeeded (order
 * matters: object first, then row — a crash in between just means a retry next
 * run). `apply=false` only reports.
 *
 * This is also where vault bytes are refunded to users.storage_used. The refund
 * belongs HERE and not at soft-delete time: until the object is actually gone
 * from R2 the user is still occupying the storage they were charged for.
 *
 * Refund ordering matters — it runs AFTER the row delete commits, so a crash
 * mid-run can only ever undercount the refund (the row is gone, its bytes stay
 * charged) and never double-refund (which would understate usage and hand out
 * free quota on every retry). The drift is repairable by re-running
 * supabase/backfills/backfill_vault_storage.sql.
 */
export async function purgeDeletedVaultFiles(
  supabase: SupabaseClient,
  r2: S3Client,
  opts: { retentionDays: number; apply: boolean },
): Promise<VaultPurgeResult> {
  const cutoff = new Date(Date.now() - opts.retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('vault_files')
    .select('id, r2_key, user_id, file_size')
    .not('deleted_at', 'is', null)
    .lt('deleted_at', cutoff);
  if (error) throw error;

  const rows = (data ?? []) as {
    id: string;
    r2_key: string;
    user_id: string;
    file_size: number;
  }[];
  const result: VaultPurgeResult = {
    cutoff,
    scanned: rows.length,
    objectsDeleted: 0,
    rowsDeleted: 0,
    bytesRefunded: 0,
    errors: 0,
  };

  const purged: typeof rows = [];
  for (const row of rows) {
    if (!opts.apply) {
      result.objectsDeleted += 1;
      continue;
    }
    try {
      await deleteObject(r2, row.r2_key);
      result.objectsDeleted += 1;
      purged.push(row);
    } catch {
      result.errors += 1;
    }
  }

  if (opts.apply && purged.length > 0) {
    const { error: delErr } = await supabase
      .from('vault_files')
      .delete()
      .in(
        'id',
        purged.map((r) => r.id),
      );
    if (delErr) throw delErr;
    result.rowsDeleted = purged.length;

    // One RPC call per user, not per file. increment_storage_used clamps at 0
    // server-side (rule 8's atomic path), which is the GREATEST(0, ...) guard.
    const bytesByUser = new Map<string, number>();
    for (const row of purged) {
      bytesByUser.set(row.user_id, (bytesByUser.get(row.user_id) ?? 0) + Number(row.file_size));
    }
    for (const [userId, bytes] of bytesByUser) {
      try {
        await adjustStorageUsed(supabase, userId, -bytes);
        result.bytesRefunded += bytes;
      } catch {
        // Never fail the sweep over a refund — the objects are already gone and
        // the next run won't see these rows. Counts as an error for visibility.
        result.errors += 1;
      }
    }
  }

  return result;
}

export interface LegacyBoxPurgeResult {
  cutoff: string;
  scanned: number;
  objectsDeleted: number;
  /** legacy_box_photos rows removed (child rows — hard delete is fine for them) */
  photoRowsDeleted: number;
  errors: number;
}

/**
 * กล่องของขวัญ counterpart (migration 033): after the retention window, delete
 * the R2 photo objects of soft-deleted boxes AND the box's voice clip if it has
 * one (migration 035 — the clip's key lives on the box row rather than in a
 * child table, so it has to be swept explicitly; missing it would leave a
 * recording of someone's voice in R2 forever after they deleted the box),
 * hard-delete their legacy_box_photos rows (child rows carrying only storage
 * keys — nothing needs them once the objects are gone), and stamp `purged_at`
 * on the box row,
 * which is KEPT as a tombstone (rule 6). NO quota refund here: the box's bytes
 * were already refunded at soft-delete time (DELETE /legacy-box/:id), so a
 * refund in the sweep would double-pay. A box is only stamped once every one
 * of its objects deleted cleanly, so a partial failure retries next run.
 * `apply=false` only reports.
 */
export async function purgeDeletedBoxes(
  supabase: SupabaseClient,
  r2: S3Client,
  opts: { retentionDays: number; apply: boolean },
): Promise<LegacyBoxPurgeResult> {
  const cutoff = new Date(Date.now() - opts.retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('legacy_boxes')
    .select('id, audio_key')
    .not('deleted_at', 'is', null)
    .is('purged_at', null)
    .lt('deleted_at', cutoff);
  if (error) throw error;

  const boxes = (data ?? []) as { id: string; audio_key: string | null }[];
  const result: LegacyBoxPurgeResult = {
    cutoff,
    scanned: boxes.length,
    objectsDeleted: 0,
    photoRowsDeleted: 0,
    errors: 0,
  };

  for (const box of boxes) {
    const { data: photoData, error: photoErr } = await supabase
      .from('legacy_box_photos')
      .select('id, r2_key')
      .eq('box_id', box.id);
    if (photoErr) throw photoErr;
    const photos = (photoData ?? []) as { id: string; r2_key: string }[];

    // Every R2 object the box owns: its photos, plus its voice clip (035).
    const objectKeys = photos.map((p) => p.r2_key);
    if (box.audio_key) objectKeys.push(box.audio_key);

    if (!opts.apply) {
      result.objectsDeleted += objectKeys.length;
      continue;
    }

    let ok = true;
    for (const key of objectKeys) {
      try {
        await deleteObject(r2, key);
        result.objectsDeleted += 1;
      } catch {
        result.errors += 1;
        ok = false;
      }
    }
    if (!ok) continue; // leave the box unstamped so the next run retries

    if (photos.length > 0) {
      const { error: delErr } = await supabase
        .from('legacy_box_photos')
        .delete()
        .eq('box_id', box.id);
      if (delErr) throw delErr;
      result.photoRowsDeleted += photos.length;
    }

    // Tombstone: purged_at stamped, title/message redacted (they ARE the
    // box's content) and audio_key nulled now that the object behind it is
    // gone — a dangling key would make later runs re-attempt a delete that can
    // never succeed. Row kept — never DELETE FROM legacy_boxes.
    const { error: markErr } = await supabase
      .from('legacy_boxes')
      .update({
        purged_at: new Date().toISOString(),
        title: '[deleted]',
        message: '',
        audio_key: null,
      })
      .eq('id', box.id);
    if (markErr) throw markErr;
  }

  return result;
}

export interface ScanTempSweepResult {
  cutoff: string;
  /** collecting sessions past their TTL that this run flipped to 'cancelled' */
  expiredReaped: number;
  /** sessions whose temp page objects were actually cleaned this run */
  sessionsSwept: number;
  objectsDeleted: number;
  errors: number;
}

// 24h — well past the 2h scan-session TTL, so a session created this long ago is
// fully settled (finalize's inline cleanup has long since run or failed).
const SCAN_TEMP_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Safety net for orphaned scan-temp page images. Two sources leak them:
 *  - sessions abandoned mid-collection: once past `expires_at` a session is
 *    unreachable (getActiveSession ignores it, so no more pages arrive and the
 *    user can't finalize it), yet nothing else ever cancels it. We reap those to
 *    'cancelled' here — flipping status FIRST so we never delete pages out from
 *    under a still-'collecting' (or 'processing') session.
 *  - sessions cancelled/done more than the retention window ago that still carry
 *    scan_pages rows (cancelled before the inline cleanup shipped, or a missed
 *    edge case; also 'done' sessions whose rows linger after finalize deleted
 *    their objects).
 *
 * Cleanup is delegated to {@link deleteScanTempObjects} (best-effort per object,
 * never throws). Idempotent: a session left with no rows is not re-matched next
 * run. scan_sessions has no `updated_at`, so `created_at` is the age cutoff for
 * the aged set — safe because a done/cancelled session never reverts to active.
 */
export async function purgeOrphanScanTemp(supabase: SupabaseClient): Promise<ScanTempSweepResult> {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - SCAN_TEMP_RETENTION_MS).toISOString();

  const result: ScanTempSweepResult = {
    cutoff,
    expiredReaped: 0,
    sessionsSwept: 0,
    objectsDeleted: 0,
    errors: 0,
  };

  // Reap sessions abandoned mid-collection — flip past-TTL 'collecting' rows to
  // 'cancelled' so their temp pages become eligible for cleanup below.
  const { data: reaped, error: reapErr } = await supabase
    .from('scan_sessions')
    .update({ status: 'cancelled' })
    .eq('status', 'collecting')
    .lt('expires_at', now)
    .select('id');
  if (reapErr) throw reapErr;
  const reapedIds = ((reaped ?? []) as { id: string }[]).map((r) => r.id);
  result.expiredReaped = reapedIds.length;

  // Aged cancelled/done sessions that may still hold temp pages.
  const { data: aged, error: agedErr } = await supabase
    .from('scan_sessions')
    .select('id')
    .in('status', ['cancelled', 'done'])
    .lt('created_at', cutoff);
  if (agedErr) throw agedErr;

  // Dedup — a just-reaped session could also be old enough to appear in `aged`.
  const sessionIds = new Set<string>(reapedIds);
  for (const row of (aged ?? []) as { id: string }[]) sessionIds.add(row.id);

  for (const sessionId of sessionIds) {
    const { objectsDeleted, errors } = await deleteScanTempObjects(supabase, sessionId);
    result.objectsDeleted += objectsDeleted;
    result.errors += errors;
    if (objectsDeleted > 0) result.sessionsSwept += 1;
  }

  return result;
}
