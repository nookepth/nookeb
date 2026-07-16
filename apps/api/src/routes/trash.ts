import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { FileRecord, TrashFileDto, TrashListResponse } from '@nookeb/shared';
import { config } from '../config';
import { presignedGetUrl } from '../services/r2.service';
import { incrementPersonalStorage } from '../services/file.service';
import { incrementTeamStorage, StorageQuotaError } from '../services/team.service';
import { purgeFileRows } from '../services/purge.service';
import { logEvent } from '../services/events.service';

/**
 * ถังขยะ (Trash Bin) API — migration 032. A "trashed" file is simply a
 * soft-deleted row whose R2 object the daily purge hasn't removed yet
 * (`deleted_at IS NOT NULL AND purged_at IS NULL`); these routes let the web
 * dashboard list, restore, and manually purge them within the retention window
 * (free: PURGE_RETENTION_DAYS, pro/team plan: TRASH_RETENTION_DAYS_PRO).
 *
 * All routes are scoped to the UPLOADER (uploaded_by = the authenticated user)
 * — deliberately NOT space membership: a teammate must never restore or purge
 * someone else's deleted file, matching the delete route's uploader-only rule
 * for team files. getAuthorizedFile from routes/files.ts is unusable here (it
 * filters deleted rows out), hence the dedicated getDeletedFile loader.
 *
 * Quota: soft delete already refunded the ledger that was charged
 * (files.charged_to, migration 015), so restore must RE-CHARGE that same
 * ledger — with enforcement, so a full quota blocks the restore — and manual
 * purge must NOT refund again.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Batch size for POST /trash/empty — bounds each R2 round + DB stamp. */
const EMPTY_BATCH_SIZE = 20;

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

/** Whole days until the daily purge removes this file's R2 object (never negative). */
function daysUntilPurge(deletedAt: string, retentionDays: number): number {
  const purgeAt = new Date(deletedAt).getTime() + retentionDays * DAY_MS;
  return Math.max(0, Math.ceil((purgeAt - Date.now()) / DAY_MS));
}

const trashRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  /** The user's effective trash retention (their `users.plan` decides the window). */
  async function getRetention(userId: string): Promise<{ plan: 'free' | 'pro'; retentionDays: number }> {
    const { data, error } = await app.supabase
      .from('users')
      .select('plan')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    const plan = (data as { plan: string | null } | null)?.plan;
    const isPro = plan === 'pro' || plan === 'team';
    return {
      plan: isPro ? 'pro' : 'free',
      retentionDays: isPro ? config.TRASH_RETENTION_DAYS_PRO : config.PURGE_RETENTION_DAYS,
    };
  }

  // Loads a TRASHED file (soft-deleted, not yet purged) owned by the caller.
  // Owner check is uploaded_by — never space membership (see module header).
  async function getDeletedFile(fileId: string, userId: string): Promise<FileRecord | null> {
    const { data, error } = await app.supabase
      .from('files')
      .select('*')
      .eq('id', fileId)
      .eq('uploaded_by', userId)
      .not('deleted_at', 'is', null)
      .is('purged_at', null)
      .maybeSingle();
    if (error) throw error;
    return (data as FileRecord | null) ?? null;
  }

  // GET /trash — the caller's trashed files, most recently deleted first.
  app.get('/trash', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
    }
    const { page, limit } = parsed.data;
    const userId = request.authUser!.userId;

    const { plan, retentionDays } = await getRetention(userId);

    const { data, count, error } = await app.supabase
      .from('files')
      .select('*', { count: 'exact' })
      .eq('uploaded_by', userId)
      .not('deleted_at', 'is', null)
      .is('purged_at', null)
      .order('deleted_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);
    if (error) throw error;

    const rows = data as FileRecord[];
    const files: TrashFileDto[] = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        spaceId: row.space_id,
        folderId: row.trash_origin_folder_id ?? null,
        name: row.display_name ?? row.original_name,
        mimeType: row.mime_type,
        fileSize: row.file_size,
        // deleted_at is non-null by the query filter
        deletedAt: row.deleted_at!,
        daysUntilPurge: daysUntilPurge(row.deleted_at!, retentionDays),
        thumbnailUrl: row.thumbnail_key ? await presignedGetUrl(app.r2, row.thumbnail_key) : null,
      })),
    );

    const response: TrashListResponse = {
      files,
      total: count ?? 0,
      page,
      limit,
      plan,
      retentionDays,
    };
    return response;
  });

  // POST /trash/:id/restore — un-delete: re-charge the quota ledger the soft
  // delete refunded, then flip the row back to live. Charge-then-flip order:
  // the enforced charge is what can fail (quota full), and if the flip then
  // loses a race the charge is rolled back below.
  app.post<{ Params: { id: string } }>('/trash/:id/restore', async (request, reply) => {
    const userId = request.authUser!.userId;
    const file = await getDeletedFile(request.params.id, userId);
    if (!file) return reply.code(404).send({ error: 'File not found in trash' });

    // Mirror of the delete route's refund routing (files.ts): charge back the
    // ledger that was actually charged for this file. charged_to is the
    // immutable ledger stamp (migration 015); team_id is the legacy fallback.
    const chargedTo = file.charged_to ?? (file.team_id ? 'team' : 'personal');
    const chargedTeamId = chargedTo === 'team' ? (file.charged_team_id ?? file.team_id ?? null) : null;

    if (file.file_size > 0) {
      if (chargedTo === 'team') {
        // charged team unknown (hard-deleted row) → the delete refunded no one,
        // so restore charges no one either.
        if (chargedTeamId) {
          try {
            await incrementTeamStorage(app.supabase, chargedTeamId, file.file_size, { enforce: true });
          } catch (err) {
            if (err instanceof StorageQuotaError) {
              void logEvent(app.supabase, {
                eventType: 'feature_blocked_quota',
                userId,
                spaceId: file.space_id,
                source: 'web',
                metadata: { feature: 'trash_restore', bytes: file.file_size },
              });
              return reply.code(409).send({
                error: 'พื้นที่ทีมไม่เพียงพอ โปรดลบไฟล์อื่นก่อนกู้คืนไฟล์นี้',
                code: 'QUOTA_EXCEEDED',
              });
            }
            throw err;
          }
        }
      } else {
        const quota = await incrementPersonalStorage(app.supabase, userId, file.file_size, {
          enforce: true,
        });
        if (quota.overLimit) {
          void logEvent(app.supabase, {
            eventType: 'feature_blocked_quota',
            userId,
            spaceId: file.space_id,
            source: 'web',
            metadata: { feature: 'trash_restore', bytes: file.file_size },
          });
          return reply.code(409).send({
            error: 'พื้นที่ไม่เพียงพอ โปรดลบไฟล์อื่นก่อนกู้คืนไฟล์นี้',
            code: 'QUOTA_EXCEEDED',
          });
        }
      }
    }

    // Restore into the origin folder only if it still exists in the same space
    // (the FK nulls trash_origin_folder_id on folder delete, but re-check the
    // space to be safe) — otherwise fall back to the space root.
    let targetFolderId: string | null = null;
    let folderName: string | null = null;
    if (file.trash_origin_folder_id) {
      const { data: folder, error: folderErr } = await app.supabase
        .from('folders')
        .select('id, name')
        .eq('id', file.trash_origin_folder_id)
        .eq('space_id', file.space_id)
        .maybeSingle();
      if (folderErr) throw folderErr;
      if (folder) {
        targetFolderId = (folder as { id: string }).id;
        folderName = (folder as { name: string }).name;
      }
    }

    // Same concurrency-guard pattern as the delete route: only THIS request's
    // UPDATE flipping the row keeps the charge above; a lost race rolls it back.
    const { data: restoredRows, error } = await app.supabase
      .from('files')
      .update({
        deleted_at: null,
        trash_origin_folder_id: null,
        folder_id: targetFolderId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', file.id)
      .not('deleted_at', 'is', null)
      .is('purged_at', null)
      .select('id');
    if (error) throw error;

    if (!restoredRows || restoredRows.length === 0) {
      // A concurrent restore or purge got there first — undo our charge.
      if (file.file_size > 0) {
        if (chargedTo === 'team' && chargedTeamId) {
          await incrementTeamStorage(app.supabase, chargedTeamId, -file.file_size, { enforce: false });
        } else if (chargedTo === 'personal') {
          await incrementPersonalStorage(app.supabase, userId, -file.file_size, { enforce: false });
        }
      }
      return reply
        .code(409)
        .send({ error: 'ไฟล์นี้ถูกกู้คืนหรือลบถาวรไปแล้ว ลองรีเฟรชหน้าอีกครั้ง', code: 'TRASH_CONFLICT' });
    }

    void logEvent(app.supabase, {
      eventType: 'file_restored',
      userId,
      spaceId: file.space_id,
      source: 'web',
      metadata: { bytes: file.file_size },
    });
    return { success: true, folderId: targetFolderId, folderName };
  });

  // DELETE /trash/:id/permanent — user-triggered purge of one trashed file:
  // R2 objects removed now, row stamped purged_at + redacted (kept as a
  // tombstone, rule 6 — never DELETE FROM files). Storage was already refunded
  // at soft-delete time, so there is NO quota adjustment here.
  app.delete<{ Params: { id: string } }>('/trash/:id/permanent', async (request, reply) => {
    const userId = request.authUser!.userId;
    const file = await getDeletedFile(request.params.id, userId);
    if (!file) return reply.code(404).send({ error: 'File not found in trash' });

    const result = await purgeFileRows(app.supabase, app.r2, [
      { id: file.id, r2_key: file.r2_key, thumbnail_key: file.thumbnail_key },
    ]);
    if (result.purgedFileIds.length === 0) {
      // An R2 delete failed — row left intact so the daily purge (or a retry
      // of this request) can finish the job against consistent metadata.
      return reply.code(502).send({ error: 'ลบถาวรไม่สำเร็จ ลองใหม่อีกครั้งน้า' });
    }

    void logEvent(app.supabase, {
      eventType: 'file_purged_manual',
      userId,
      spaceId: file.space_id,
      source: 'web',
      metadata: { bytes: file.file_size, files: 1 },
    });
    return { success: true };
  });

  // POST /trash/empty — purge the caller's ENTIRE trash, in batches so one
  // request never holds thousands of R2 rounds. Same purge path (and same
  // no-refund rule) as /trash/:id/permanent.
  app.post('/trash/empty', async (request, reply) => {
    const userId = request.authUser!.userId;
    let count = 0;
    let errors = 0;

    // Successfully purged rows leave the filter (purged_at stamped), so
    // re-selecting the first batch walks the whole set. Rows whose R2 delete
    // failed would match forever — the no-progress break below stops that.
    for (;;) {
      const { data, error } = await app.supabase
        .from('files')
        .select('id, r2_key, thumbnail_key')
        .eq('uploaded_by', userId)
        .not('deleted_at', 'is', null)
        .is('purged_at', null)
        .limit(EMPTY_BATCH_SIZE);
      if (error) throw error;

      const rows = (data ?? []) as { id: string; r2_key: string; thumbnail_key: string | null }[];
      if (rows.length === 0) break;

      const result = await purgeFileRows(app.supabase, app.r2, rows);
      count += result.purgedFileIds.length;
      errors += result.errors;
      if (result.purgedFileIds.length === 0) break; // no progress — stop, daily purge retries
    }

    if (count === 0 && errors > 0) {
      return reply.code(502).send({ error: 'ล้างถังขยะไม่สำเร็จ ลองใหม่อีกครั้งน้า' });
    }

    if (count > 0) {
      void logEvent(app.supabase, {
        eventType: 'file_purged_manual',
        userId,
        source: 'web',
        metadata: { files: count },
      });
    }
    return { success: true, count };
  });
};

export default trashRoutes;
