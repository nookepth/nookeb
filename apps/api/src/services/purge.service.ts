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

  return result;
}
