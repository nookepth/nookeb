import type { FastifyPluginAsync } from 'fastify';
import type { S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { toFileDto, type FileDto, type FileListResponse, type FileRecord } from '@nookeb/shared';
import { presignedGetUrl } from '../services/r2.service';
import { adjustStorageUsed, isSpaceMember } from '../services/file.service';

const listQuerySchema = z.object({
  spaceId: z.string().uuid(),
  folderId: z.string().uuid().optional(),
  tagId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().optional(),
  sortBy: z.enum(['created_at', 'original_name', 'file_size']).default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

async function toDtoWithExtras(
  r2: S3Client,
  row: FileRecord,
  tagIds: string[],
): Promise<FileDto> {
  return {
    ...toFileDto(row),
    tagIds,
    thumbnailUrl: row.thumbnail_key ? await presignedGetUrl(r2, row.thumbnail_key) : null,
  };
}

const filesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  // GET /files — list files in a space
  app.get('/files', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
    }
    const { spaceId, folderId, tagId, page, limit, search, sortBy, order } = parsed.data;
    const userId = request.authUser!.userId;

    if (!(await isSpaceMember(app.supabase, spaceId, userId))) {
      return reply.code(403).send({ error: 'Not a member of this space' });
    }

    let query = app.supabase
      .from('files')
      .select('*', { count: 'exact' })
      .eq('space_id', spaceId)
      .is('deleted_at', null)
      .order(sortBy, { ascending: order === 'asc' })
      .range((page - 1) * limit, page * limit - 1);

    if (folderId) query = query.eq('folder_id', folderId);
    // search matches the visible name (original/display) and OCR-extracted text.
    // Strip PostgREST or() syntax characters so user input cannot break the filter.
    if (search) {
      const safe = search.replace(/[(),]/g, ' ').trim();
      if (safe) {
        query = query.or(
          `original_name.ilike.%${safe}%,display_name.ilike.%${safe}%,ocr_text.ilike.%${safe}%`,
        );
      }
    }

    if (tagId) {
      const { data: tagged, error: taggedErr } = await app.supabase
        .from('file_tags')
        .select('file_id')
        .eq('tag_id', tagId);
      if (taggedErr) throw taggedErr;
      const ids = (tagged as { file_id: string }[]).map((t) => t.file_id);
      if (ids.length === 0) {
        return { files: [], total: 0, page, limit } satisfies FileListResponse;
      }
      query = query.in('id', ids);
    }

    const { data, count, error } = await query;
    if (error) throw error;
    const rows = data as FileRecord[];

    // tag ids for the page's files in one query
    const tagsByFile = new Map<string, string[]>();
    if (rows.length > 0) {
      const { data: fileTags, error: ftErr } = await app.supabase
        .from('file_tags')
        .select('file_id, tag_id')
        .in('file_id', rows.map((r) => r.id));
      if (ftErr) throw ftErr;
      for (const ft of fileTags as { file_id: string; tag_id: string }[]) {
        const list = tagsByFile.get(ft.file_id) ?? [];
        list.push(ft.tag_id);
        tagsByFile.set(ft.file_id, list);
      }
    }

    const response: FileListResponse = {
      files: await Promise.all(
        rows.map((row) => toDtoWithExtras(app.r2, row, tagsByFile.get(row.id) ?? [])),
      ),
      total: count ?? 0,
      page,
      limit,
    };
    return response;
  });

  // Loads a file row and enforces space membership
  async function getAuthorizedFile(fileId: string, userId: string): Promise<FileRecord | null> {
    const { data, error } = await app.supabase
      .from('files')
      .select('*')
      .eq('id', fileId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const file = data as FileRecord;
    if (!(await isSpaceMember(app.supabase, file.space_id, userId))) return null;
    return file;
  }

  // GET /files/:id — file detail + presigned URL (expires 1 hour)
  app.get<{ Params: { id: string } }>('/files/:id', async (request, reply) => {
    const file = await getAuthorizedFile(request.params.id, request.authUser!.userId);
    if (!file) return reply.code(404).send({ error: 'File not found' });

    const url = file.status === 'ready' ? await presignedGetUrl(app.r2, file.r2_key) : null;
    const { data: fileTags, error: ftErr } = await app.supabase
      .from('file_tags')
      .select('tag_id')
      .eq('file_id', file.id);
    if (ftErr) throw ftErr;
    const dto = await toDtoWithExtras(
      app.r2,
      file,
      (fileTags as { tag_id: string }[]).map((t) => t.tag_id),
    );
    return { ...dto, url };
  });

  // GET /files/:id/download — 302 redirect to presigned R2 URL
  app.get<{ Params: { id: string } }>('/files/:id/download', async (request, reply) => {
    const file = await getAuthorizedFile(request.params.id, request.authUser!.userId);
    if (!file) return reply.code(404).send({ error: 'File not found' });
    if (file.status !== 'ready') {
      return reply.code(409).send({ error: `File not ready (status: ${file.status})` });
    }

    const url = await presignedGetUrl(app.r2, file.r2_key, file.display_name ?? file.original_name);
    return reply.code(302).redirect(url);
  });

  // PATCH /files/:id — rename / move
  app.patch<{ Params: { id: string } }>('/files/:id', async (request, reply) => {
    const bodySchema = z.object({
      displayName: z.string().min(1).optional(),
      folderId: z.string().uuid().nullable().optional(),
    });
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }

    const file = await getAuthorizedFile(request.params.id, request.authUser!.userId);
    if (!file) return reply.code(404).send({ error: 'File not found' });

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (parsed.data.displayName !== undefined) updates['display_name'] = parsed.data.displayName;
    if (parsed.data.folderId !== undefined) updates['folder_id'] = parsed.data.folderId;

    const { data, error } = await app.supabase
      .from('files')
      .update(updates)
      .eq('id', file.id)
      .select('*')
      .single();
    if (error) throw error;
    return toFileDto(data as FileRecord);
  });

  // POST /files/:id/tags — attach a tag (idempotent)
  app.post<{ Params: { id: string } }>('/files/:id/tags', async (request, reply) => {
    const parsed = z.object({ tagId: z.string().uuid() }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }

    const file = await getAuthorizedFile(request.params.id, request.authUser!.userId);
    if (!file) return reply.code(404).send({ error: 'File not found' });

    // tag must belong to the same space as the file
    const { data: tag, error: tagErr } = await app.supabase
      .from('tags')
      .select('id')
      .eq('id', parsed.data.tagId)
      .eq('space_id', file.space_id)
      .maybeSingle();
    if (tagErr) throw tagErr;
    if (!tag) return reply.code(400).send({ error: 'Tag not found in this space' });

    const { error } = await app.supabase
      .from('file_tags')
      .upsert({ file_id: file.id, tag_id: parsed.data.tagId });
    if (error) throw error;
    return reply.code(204).send();
  });

  // DELETE /files/:id/tags/:tagId — detach a tag
  app.delete<{ Params: { id: string; tagId: string } }>(
    '/files/:id/tags/:tagId',
    async (request, reply) => {
      const file = await getAuthorizedFile(request.params.id, request.authUser!.userId);
      if (!file) return reply.code(404).send({ error: 'File not found' });

      const { error } = await app.supabase
        .from('file_tags')
        .delete()
        .eq('file_id', file.id)
        .eq('tag_id', request.params.tagId);
      if (error) throw error;
      return reply.code(204).send();
    },
  );

  // DELETE /files/:id — soft delete only (never hard DELETE), and free the quota
  app.delete<{ Params: { id: string } }>('/files/:id', async (request, reply) => {
    const file = await getAuthorizedFile(request.params.id, request.authUser!.userId);
    if (!file) return reply.code(404).send({ error: 'File not found' });

    const { error } = await app.supabase
      .from('files')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', file.id);
    if (error) throw error;

    // Return the freed space to the uploader's quota (also re-arms the storage
    // alert once usage drops back under the reset line)
    if (file.uploaded_by && file.file_size > 0) {
      await adjustStorageUsed(app.supabase, file.uploaded_by, -file.file_size, file.space_id);
    }
    return reply.code(204).send();
  });
};

export default filesRoutes;
