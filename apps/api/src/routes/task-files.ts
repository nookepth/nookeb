import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import type { TaskFileKind } from '@nookeb/shared';
import { logEvent } from '../services/events.service';
import { buildFileKey, deleteObject, presignedGetUrl, uploadStream } from '../services/r2.service';
import {
  createFileRecord,
  ensureUserAndSpace,
  incrementPersonalStorage,
  markFileError,
  markFileReady,
} from '../services/file.service';
import {
  attachTaskFile,
  detachTaskFile,
  getTaskFile,
  getTaskWithDetails,
  isGroupMember,
  listTaskFiles,
  toTaskFileDto,
  type TaskWithDetails,
} from '../services/task.service';

/**
 * ระบบตามงาน — แนบไฟล์กับงาน (migration 045).
 *
 * Registered in its OWN scope because it is the only task route that needs
 * @fastify/multipart, which installs a content-type parser for the whole scope
 * it is registered in (the vault does the same for the same reason). Splitting
 * it also keeps routes/tasks.ts a pure JSON surface.
 *
 * Upload model — multipart THROUGH the API, deliberately NOT a presigned PUT.
 * A presigned PUT lands bytes the API never sees, which makes both the size cap
 * and the quota charge advisory (the lesson already paid for by the legacy-box
 * voice clip). Streaming through here is what makes them real, and rule 3 still
 * holds: bytes go straight to R2, never buffered or written to disk.
 *
 * Downloads DO use presigned URLs (rule 5) — GET …/files returns 1h signed
 * links; binary is never proxied back out through the API.
 */

const MAX_FILES_PER_UPLOAD = 5;
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB per file
const MAX_FILES_PER_TASK = 30;

const uploadQuerySchema = z.object({
  /** attach the files to one item's submission; omitted = task-level */
  itemId: z.string().uuid().optional(),
  kind: z.enum(['brief', 'submission']).default('brief'),
});

/** Everyone who may SEE a task's attachments: same rule as GET /tasks/:id. */
function canView(task: TaskWithDetails, lineUid: string, isMember: boolean): boolean {
  return (
    isMember ||
    task.created_by_line_uid === lineUid ||
    task.items.some((i) => i.assignees.some((a) => a.line_uid === lineUid))
  );
}

/**
 * Who may ATTACH/REMOVE: the creator, or someone actually on the hook for a
 * part of it. Stricter than canView on purpose — a group member who is merely
 * a bystander shouldn't be able to spend the creator's… actually their OWN
 * quota into someone else's task thread.
 */
function canContribute(task: TaskWithDetails, lineUid: string): boolean {
  return (
    task.created_by_line_uid === lineUid ||
    task.items.some((i) => i.assignees.some((a) => a.line_uid === lineUid))
  );
}

/** ".pdf" → "pdf"; no dot / trailing dot → null. */
function extensionOf(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return null;
  return filename.slice(dot + 1).toLowerCase().slice(0, 20);
}

const taskFilesRoutes: FastifyPluginAsync = async (app) => {
  await app.register(multipart, {
    limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_UPLOAD, fields: 5 },
  });

  app.addHook('preHandler', async (request, reply) => app.authenticate(request, reply));

  /**
   * Load the task and enforce the caller's relationship to it. Returns null
   * once it has already sent a reply.
   */
  async function loadTask(
    taskId: string,
    lineUid: string,
    need: 'view' | 'contribute',
    reply: FastifyReply,
  ): Promise<TaskWithDetails | null> {
    const task = await getTaskWithDetails(app.supabase, taskId);
    if (!task) {
      await reply.code(404).send({ error: 'Task not found' });
      return null;
    }
    if (need === 'contribute') {
      if (!canContribute(task, lineUid)) {
        await reply.code(403).send({ error: 'งานนี้ไม่ได้เกี่ยวกับเราน้า แนบไฟล์ไม่ได้' });
        return null;
      }
      return task;
    }
    // READ-ONLY membership check (never enrolls) — mirrors GET /tasks/:id: a
    // task UUID leaks through the unauthenticated ICS link, so holding one must
    // not upgrade anybody into the group's roster.
    const member = task.is_personal
      ? false
      : await isGroupMember(app.supabase, task.group_line_id!, lineUid);
    if (!canView(task, lineUid, member)) {
      await reply.code(403).send({ error: 'Forbidden' });
      return null;
    }
    return task;
  }

  /**
   * Where a task's attachments are stored. The task's linked group space when
   * it has one (so the group's dashboard lists them alongside its other files),
   * otherwise the uploader's personal space.
   *
   * Quota is ALWAYS charged to the uploader's personal pool (charged_to keeps
   * its 'personal' default), even in a team-bound space: the person who chose
   * to attach the file is the one who pays, and the DELETE/restore refund paths
   * read the same ledger column, so it stays symmetric.
   */
  async function resolveSpaceId(task: TaskWithDetails, lineUid: string): Promise<string> {
    if (task.space_id) return task.space_id;
    const { space } = await ensureUserAndSpace(app.supabase, lineUid);
    return space.id;
  }

  // ---- POST /tasks/:taskId/files — multipart upload (≤5 files, ≤20 MB each) ----
  app.post<{ Params: { taskId: string } }>(
    '/tasks/:taskId/files',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const idParsed = z.string().uuid().safeParse(request.params.taskId);
      if (!idParsed.success) return reply.code(400).send({ error: 'Invalid task id' });
      const queryParsed = uploadQuerySchema.safeParse(request.query);
      if (!queryParsed.success) {
        return reply.code(400).send({ error: 'Invalid query', issues: queryParsed.error.issues });
      }
      const { itemId, kind } = queryParsed.data;

      const lineUid = request.authUser!.lineUserId;
      const userId = request.authUser!.userId;
      const task = await loadTask(idParsed.data, lineUid, 'contribute', reply);
      if (!task) return;
      if (task.status === 'cancelled') {
        return reply.code(409).send({ error: 'งานนี้ถูกยกเลิกไปแล้วน้า' });
      }
      if (itemId && !task.items.some((i) => i.id === itemId)) {
        return reply.code(404).send({ error: 'Task item not found' });
      }
      if (task.files.length >= MAX_FILES_PER_TASK) {
        return reply.code(409).send({ error: `แนบไฟล์ได้สูงสุด ${MAX_FILES_PER_TASK} ไฟล์ต่องานน้า` });
      }

      const spaceId = await resolveSpaceId(task, lineUid);
      const stored: ReturnType<typeof toTaskFileDto>[] = [];
      /** Reported per-file so a partial success still tells the user what failed. */
      const rejected: { name: string; reason: string }[] = [];

      // Multipart parts MUST be consumed in order — each file's stream has to be
      // drained (or the request aborted) before the next part arrives. So a
      // failure on one file breaks the loop rather than skipping ahead.
      for await (const part of request.files()) {
        if (stored.length + rejected.length >= MAX_FILES_PER_UPLOAD) break;
        const originalName = (part.filename || 'file').slice(0, 255);
        const fileId = randomUUID();
        const r2Key = buildFileKey(spaceId, fileId, originalName);

        const { record } = await createFileRecord(app.supabase, {
          id: fileId,
          spaceId,
          uploadedBy: userId,
          originalName,
          mimeType: part.mimetype || 'application/octet-stream',
          fileSize: 0, // settled by markFileReady once the stream is counted
          extension: extensionOf(originalName),
          r2Key,
          // Not a LINE upload — no message to dedupe against (migration 022's
          // unique index only covers non-null line_message_id).
          lineMessageId: null,
          lineSource: null,
          lineGroupId: null,
          scanStatus: null,
        });

        let size: number;
        try {
          ({ size } = await uploadStream(
            app.r2,
            r2Key,
            part.file,
            part.mimetype || 'application/octet-stream',
            MAX_FILE_BYTES,
          ));
        } catch (err) {
          // uploadStream already removed any partial object.
          await markFileError(app.supabase, fileId);
          request.log.error({ err, fileId, taskId: task.id }, 'task file upload failed');
          rejected.push({ name: originalName, reason: 'upload_failed' });
          continue;
        }

        // @fastify/multipart TRUNCATES at the fileSize limit instead of erroring,
        // so a too-big file arrives as a short, valid-looking stream. Storing it
        // would hand the user a silently corrupt attachment.
        if (part.file.truncated) {
          await deleteObject(app.r2, r2Key).catch(() => {});
          await markFileError(app.supabase, fileId);
          rejected.push({ name: originalName, reason: 'too_large' });
          continue;
        }

        // Charge AFTER the bytes are counted, WITH enforcement. Over quota →
        // the file is removed again rather than kept: the alternative (vault's
        // charge-best-effort) silently lets a user past their limit, and here we
        // have a natural place to say no.
        const quota = await incrementPersonalStorage(app.supabase, userId, size, {
          enforce: true,
        });
        if (quota.overLimit) {
          await deleteObject(app.r2, r2Key).catch(() => {});
          await markFileError(app.supabase, fileId);
          rejected.push({ name: originalName, reason: 'quota_exceeded' });
          void logEvent(app.supabase, {
            eventType: 'feature_blocked_quota',
            userId,
            spaceId,
            source: 'web',
            metadata: { bytes: size },
          });
          continue;
        }

        await markFileReady(app.supabase, fileId, size);
        const attachment = await attachTaskFile(app.supabase, {
          taskId: task.id,
          taskItemId: itemId ?? null,
          fileId,
          uploadedByLineUid: lineUid,
          kind: kind as TaskFileKind,
        });
        stored.push(
          toTaskFileDto(
            { ...attachment, file: { ...record, file_size: size, status: 'ready' } },
            await presignedGetUrl(app.r2, r2Key, originalName),
          ),
        );
      }

      if (stored.length === 0 && rejected.length === 0) {
        return reply.code(400).send({ error: 'ไม่พบไฟล์ที่แนบมาน้า' });
      }
      return reply.code(stored.length > 0 ? 201 : 400).send({ files: stored, rejected });
    },
  );

  // ---- GET /tasks/:taskId/files — attachment list with presigned URLs ----
  app.get<{ Params: { taskId: string } }>('/tasks/:taskId/files', async (request, reply) => {
    const idParsed = z.string().uuid().safeParse(request.params.taskId);
    if (!idParsed.success) return reply.code(400).send({ error: 'Invalid task id' });

    const task = await loadTask(idParsed.data, request.authUser!.lineUserId, 'view', reply);
    if (!task) return;

    const rows = await listTaskFiles(app.supabase, task.id);
    const files = await Promise.all(
      rows.map(async (row) =>
        toTaskFileDto(
          row,
          row.file.status === 'ready'
            ? await presignedGetUrl(app.r2, row.file.r2_key, row.file.display_name ?? row.file.original_name)
            : null,
        ),
      ),
    );
    return { files };
  });

  // ---- DELETE /tasks/:taskId/files/:attachmentId — detach + soft-delete ----
  app.delete<{ Params: { taskId: string; attachmentId: string } }>(
    '/tasks/:taskId/files/:attachmentId',
    async (request, reply) => {
      const idParsed = z.string().uuid().safeParse(request.params.taskId);
      const attParsed = z.string().uuid().safeParse(request.params.attachmentId);
      if (!idParsed.success || !attParsed.success) {
        return reply.code(400).send({ error: 'Invalid id' });
      }

      const lineUid = request.authUser!.lineUserId;
      const task = await loadTask(idParsed.data, lineUid, 'contribute', reply);
      if (!task) return;

      const attachment = await getTaskFile(app.supabase, task.id, attParsed.data);
      if (!attachment) return reply.code(404).send({ error: 'Attachment not found' });
      // Only the person who attached it (or the task's creator) can pull it back.
      if (attachment.uploaded_by_line_uid !== lineUid && task.created_by_line_uid !== lineUid) {
        return reply.code(403).send({ error: 'ไฟล์นี้ไม่ใช่ของเราน้า ลบไม่ได้' });
      }

      await detachTaskFile(app.supabase, task.id, attachment.id);

      // Soft delete only (rule 6) — the daily purge removes the R2 object after
      // the retention window and stamps purged_at. Refund now, matching
      // DELETE /files/:id: an unreachable file must not keep costing quota.
      //
      // The `is('deleted_at', null)` filter + affected-rows check is the guard
      // against a double refund: two concurrent detaches, or a file already
      // trashed from the dashboard, must credit the quota exactly once.
      const now = new Date().toISOString();
      const { data: softDeleted, error } = await app.supabase
        .from('files')
        .update({ deleted_at: now, updated_at: now })
        .eq('id', attachment.file_id)
        .is('deleted_at', null)
        .select('id');
      if (error) throw error;

      // Refund the UPLOADER, not the caller — the task creator may be removing
      // a teammate's attachment, and the bytes were charged to whoever attached
      // them (always the personal ledger, see resolveSpaceId).
      const chargedUserId = attachment.file.uploaded_by;
      if ((softDeleted ?? []).length > 0 && chargedUserId) {
        await incrementPersonalStorage(
          app.supabase,
          chargedUserId,
          -attachment.file.file_size,
          { enforce: false },
        );
      }

      return { success: true };
    },
  );
};

export default taskFilesRoutes;
