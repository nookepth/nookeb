import type { SupabaseClient } from '@supabase/supabase-js';
import type { S3Client } from '@aws-sdk/client-s3';
import { deleteObject } from './r2.service';

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
