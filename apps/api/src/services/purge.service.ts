import type { SupabaseClient } from '@supabase/supabase-js';
import type { S3Client } from '@aws-sdk/client-s3';
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

/**
 * Delete the R2 objects (original + thumbnail) of files that were soft-deleted
 * more than `retentionDays` ago. The DB row is kept as a tombstone — the project
 * rule forbids hard-deleting files rows. Idempotent: deleting an already-gone
 * object is a no-op, so re-running is safe.
 *
 * `apply=false` (default) only reports what would be deleted.
 */
export async function purgeDeletedFiles(
  supabase: SupabaseClient,
  r2: S3Client,
  opts: { retentionDays: number; apply: boolean },
): Promise<PurgeResult> {
  const cutoff = new Date(Date.now() - opts.retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('files')
    .select('id, r2_key, thumbnail_key, deleted_at')
    .not('deleted_at', 'is', null)
    .is('purged_at', null) // skip rows whose R2 objects are already gone
    .lt('deleted_at', cutoff);
  if (error) throw error;

  const rows = (data ?? []) as {
    id: string;
    r2_key: string;
    thumbnail_key: string | null;
    deleted_at: string;
  }[];

  const result: PurgeResult = {
    cutoff,
    scanned: rows.length,
    objectsDeleted: 0,
    errors: 0,
    purgedFileIds: [],
  };

  for (const row of rows) {
    const keys = [row.r2_key, row.thumbnail_key].filter((k): k is string => Boolean(k));
    if (!opts.apply) {
      result.purgedFileIds.push(row.id);
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
    if (ok) result.purgedFileIds.push(row.id);
  }

  // Mark tombstones as purged so the next daily run skips them entirely, and
  // redact user content from the row at the same time. Only rows whose R2
  // deletes ALL succeeded reach purgedFileIds — if an object delete failed we
  // keep the metadata intact so the next run can retry against a consistent row.
  // Names and OCR text ARE the file's content (OCR is literally the text inside
  // the image), so "deleted" must cover them too; id/space_id/file_size/
  // uploaded_by/deleted_at/purged_at are kept — they carry no content and are
  // needed for quota accounting and the audit trail.
  if (opts.apply && result.purgedFileIds.length > 0) {
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
