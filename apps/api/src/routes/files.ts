import { createHash } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { S3Client } from '@aws-sdk/client-s3';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { toFileDto, type FileDto, type FileListResponse, type FileRecord } from '@nookeb/shared';
import { config } from '../config';
import { presignedGetUrl } from '../services/r2.service';
import { adjustStorageUsed, isSpaceMember } from '../services/file.service';
import { incrementTeamStorage } from '../services/team.service';

// --- One-time download tokens ---------------------------------------------
// Browser download navigation can't set an Authorization header, and putting
// the 24h session JWT in the URL leaked it into history/proxy/server logs.
// Instead the dashboard POSTs /files/:id/download-token (normal Bearer auth)
// to mint a 60-second single-use token scoped to ONE file, then navigates to
// /files/:id/download?dl_token=... . Single use is enforced via a Redis key
// that is atomically consumed on first redemption.
const DOWNLOAD_TOKEN_TTL_SECONDS = 60;
// Separate secret so a download token can never be replayed as a session JWT
// (different signing key) even though both are HS256. DOWNLOAD_TOKEN_SECRET is
// required and validated at startup (config.ts) — no derived-from-JWT_SECRET
// fallback, which was a predictable secret.
const downloadTokenSecret = config.DOWNLOAD_TOKEN_SECRET;

interface DownloadTokenPayload {
  fileId: string;
  userId: string;
}

function signDownloadToken(payload: DownloadTokenPayload): string {
  return jwt.sign(payload, downloadTokenSecret, { expiresIn: DOWNLOAD_TOKEN_TTL_SECONDS });
}

function verifyDownloadToken(token: string): DownloadTokenPayload | null {
  try {
    const decoded = jwt.verify(token, downloadTokenSecret) as jwt.JwtPayload;
    if (typeof decoded['fileId'] !== 'string' || typeof decoded['userId'] !== 'string') return null;
    return { fileId: decoded['fileId'], userId: decoded['userId'] };
  } catch {
    return null;
  }
}

// Only the hash is stored in Redis, so the store never holds a usable token.
function downloadTokenRedisKey(token: string): string {
  return `dl:${createHash('sha256').update(token).digest('hex')}`;
}

const listQuerySchema = z.object({
  spaceId: z.string().uuid(),
  folderId: z.string().uuid().optional(),
  tagId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().optional(),
  // Dashboard type tabs bucket files into these groups (mirrors the web
  // `fileGroup` in apps/web/lib/filetype.ts). Optional — omit = all types.
  fileType: z.enum(['image', 'doc', 'video', 'other']).optional(),
  sortBy: z.enum(['created_at', 'original_name', 'file_size']).default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

// mime_type patterns that make up the "doc" tab (mirrors `fileGroup`). Used
// both to select the doc group and (negated + AND-ed) to select "other".
const DOC_MIME_MATCHERS: { op: 'eq' | 'ilike'; value: string }[] = [
  { op: 'eq', value: 'application/pdf' },
  { op: 'ilike', value: 'text/%' },
  { op: 'ilike', value: '%word%' },
  { op: 'ilike', value: '%officedocument%' },
  { op: 'ilike', value: '%spreadsheet%' },
  { op: 'ilike', value: '%presentation%' },
  { op: 'ilike', value: '%ms-excel%' },
  { op: 'ilike', value: '%ms-powerpoint%' },
];

// GET /files/stats shares the list's space/folder/tag/search filters (minus
// pagination) — the dashboard's stat chips must count ALL matching files, not
// just the page the grid is showing.
const statsQuerySchema = z.object({
  spaceId: z.string().uuid(),
  folderId: z.string().uuid().optional(),
  tagId: z.string().uuid().optional(),
  search: z.string().optional(),
});

// Strip PostgREST or() syntax characters so user input can't break the filter
// (shared by GET /files and GET /files/stats).
function buildSearchOr(search: string): string | null {
  const safe = search.replace(/[(),]/g, ' ').trim();
  if (!safe) return null;
  // Escape ILIKE metacharacters to prevent wildcard DoS.
  const escaped = safe.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  return `original_name.ilike.%${escaped}%,display_name.ilike.%${escaped}%,ocr_text.ilike.%${escaped}%`;
}

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
  // Surface the download-token secret fallback in production. When
  // DOWNLOAD_TOKEN_SECRET is unset we derive `${JWT_SECRET}:download` (kept as a
  // fallback so already-minted tokens don't break) — fine, but it means download
  // tokens share the session JWT's key material. Warn loudly at startup so this
  // is visible instead of silent; setting a real secret on Railway is an ops task.
  if (!config.DOWNLOAD_TOKEN_SECRET && config.NODE_ENV === 'production') {
    app.log.warn(
      'DOWNLOAD_TOKEN_SECRET is unset — download tokens are signed with a key ' +
        'derived from JWT_SECRET (fallback). Set a dedicated DOWNLOAD_TOKEN_SECRET.',
    );
  }

  // Every file route requires the normal Bearer JWT, EXCEPT the download route
  // when called with ?dl_token= — that one-time token is verified (signature,
  // file scope, single-use Redis key) inside the route handler itself.
  app.addHook('preHandler', async (request, reply) => {
    const dlToken = (request.query as Record<string, unknown> | undefined)?.['dl_token'];
    if (request.routeOptions.url === '/files/:id/download' && typeof dlToken === 'string') {
      return;
    }
    return app.authenticate(request, reply);
  });

  // GET /files — list files in a space
  app.get('/files', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
    }
    const { spaceId, folderId, tagId, page, limit, search, fileType, sortBy, order } = parsed.data;
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
    if (search) {
      const or = buildSearchOr(search);
      if (or) query = query.or(or);
    }

    // Type-tab filter — done server-side so pagination/count reflect the type,
    // not a client-side slice of one page. Groups mirror the web `fileGroup`.
    if (fileType === 'image') {
      query = query.ilike('mime_type', 'image/%');
    } else if (fileType === 'video') {
      query = query.ilike('mime_type', 'video/%');
    } else if (fileType === 'doc') {
      query = query.or(DOC_MIME_MATCHERS.map((m) => `mime_type.${m.op}.${m.value}`).join(','));
    } else if (fileType === 'other') {
      // "other" = not image, not video, and none of the doc matchers. AND-ing
      // the negations is the De Morgan complement of those OR groups.
      query = query.not('mime_type', 'ilike', 'image/%').not('mime_type', 'ilike', 'video/%');
      for (const m of DOC_MIME_MATCHERS) query = query.not('mime_type', m.op, m.value);
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

  // GET /files/stats — aggregate counts for the dashboard stat chips. Same
  // filters as GET /files but NOT paginated: the chips must reflect every
  // matching file, not just the page the grid renders. Returns per-mime-type
  // counts (the web client buckets them into image/doc/video/other) plus the
  // total count and summed byte size. We stream the two tiny columns in 1000-row
  // batches (Supabase caps a single select) and aggregate in memory, so the
  // result stays exact for users with thousands of files.
  app.get('/files/stats', async (request, reply) => {
    const parsed = statsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
    }
    const { spaceId, folderId, tagId, search } = parsed.data;
    const userId = request.authUser!.userId;

    if (!(await isSpaceMember(app.supabase, spaceId, userId))) {
      return reply.code(403).send({ error: 'Not a member of this space' });
    }

    // Resolve the tag filter up front (same as GET /files): no tagged files → empty stats.
    let tagFileIds: string[] | null = null;
    if (tagId) {
      const { data: tagged, error: taggedErr } = await app.supabase
        .from('file_tags')
        .select('file_id')
        .eq('tag_id', tagId);
      if (taggedErr) throw taggedErr;
      tagFileIds = (tagged as { file_id: string }[]).map((t) => t.file_id);
      if (tagFileIds.length === 0) {
        return { total: 0, byType: {}, storageUsed: 0 };
      }
    }

    const searchOr = search ? buildSearchOr(search) : null;
    const byType: Record<string, number> = {};
    let total = 0;
    let storageUsed = 0;

    const BATCH = 1000;
    for (let from = 0; ; from += BATCH) {
      let query = app.supabase
        .from('files')
        .select('mime_type, file_size')
        .eq('space_id', spaceId)
        .is('deleted_at', null)
        .range(from, from + BATCH - 1);
      if (folderId) query = query.eq('folder_id', folderId);
      if (searchOr) query = query.or(searchOr);
      if (tagFileIds) query = query.in('id', tagFileIds);

      const { data, error } = await query;
      if (error) throw error;
      const rows = data as { mime_type: string; file_size: number }[];
      for (const row of rows) {
        total += 1;
        storageUsed += row.file_size ?? 0;
        byType[row.mime_type] = (byType[row.mime_type] ?? 0) + 1;
      }
      if (rows.length < BATCH) break;
    }

    return { total, byType, storageUsed };
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

  // POST /files/:id/download-token — mint a one-time 60s download token
  // (Bearer-authenticated; membership re-checked at redemption too).
  app.post<{ Params: { id: string } }>('/files/:id/download-token', async (request, reply) => {
    const userId = request.authUser!.userId;
    const file = await getAuthorizedFile(request.params.id, userId);
    if (!file) return reply.code(404).send({ error: 'File not found' });
    if (file.status !== 'ready') {
      return reply.code(409).send({ error: `File not ready (status: ${file.status})` });
    }

    const token = signDownloadToken({ fileId: file.id, userId });
    await app.redis.set(downloadTokenRedisKey(token), '1', 'EX', DOWNLOAD_TOKEN_TTL_SECONDS);
    return { token, expiresIn: DOWNLOAD_TOKEN_TTL_SECONDS };
  });

  // GET /files/:id/download — 302 redirect to presigned R2 URL.
  // Auth: either the normal Bearer JWT (dashboard fetch) or a one-time
  // ?dl_token= minted by POST /files/:id/download-token (browser navigation).
  app.get<{ Params: { id: string }; Querystring: { dl_token?: string } }>(
    '/files/:id/download',
    async (request, reply) => {
      let userId: string;
      if (request.authUser) {
        userId = request.authUser.userId;
      } else {
        const dlToken = request.query.dl_token;
        if (typeof dlToken !== 'string') {
          return reply.code(401).send({ error: 'Unauthorized' });
        }
        const payload = verifyDownloadToken(dlToken);
        if (!payload || payload.fileId !== request.params.id) {
          return reply.code(401).send({ error: 'Invalid download token' });
        }
        // GETDEL atomically consumes the single-use key — a replayed or
        // concurrent second redemption sees no key and gets 410 Gone.
        const fresh = await app.redis.getdel(downloadTokenRedisKey(dlToken));
        if (!fresh) {
          return reply.code(410).send({ error: 'Download link already used or expired' });
        }
        userId = payload.userId;
      }

      const file = await getAuthorizedFile(request.params.id, userId);
      if (!file) return reply.code(404).send({ error: 'File not found' });
      if (file.status !== 'ready') {
        return reply.code(409).send({ error: `File not ready (status: ${file.status})` });
      }

      const url = await presignedGetUrl(app.r2, file.r2_key, file.display_name ?? file.original_name);
      return reply.code(302).redirect(url);
    },
  );

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

    // Target folder must live in the file's own space (mirror of the folder-move
    // route's parent check): a cross-space folder_id makes the file unreachable
    // from every folder view of its space, and an unknown id surfaced as a raw
    // FK 500 instead of a 400.
    if (parsed.data.folderId) {
      const { data: folder, error: folderErr } = await app.supabase
        .from('folders')
        .select('id')
        .eq('id', parsed.data.folderId)
        .eq('space_id', file.space_id)
        .maybeSingle();
      if (folderErr) throw folderErr;
      if (!folder) {
        return reply.code(400).send({ error: 'Folder not found in this space' });
      }
    }

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
    const requesterId = request.authUser!.userId;
    const file = await getAuthorizedFile(request.params.id, requesterId);
    if (!file) return reply.code(404).send({ error: 'File not found' });

    // Team files can only be deleted by whoever uploaded them (a NULL uploaded_by
    // — e.g. legacy rows — carries no restriction). Personal files keep the
    // existing space-membership guard from getAuthorizedFile.
    if (file.team_id && file.uploaded_by && file.uploaded_by !== requesterId) {
      return reply
        .code(403)
        .send({ error: 'เฉพาะคนที่อัพโหลดไฟล์นี้เท่านั้นที่ลบได้น้า' });
    }

    // Guard against a double refund from two concurrent DELETEs: both pass
    // getAuthorizedFile (row not yet deleted), so gate the soft-delete on
    // deleted_at still being NULL and only refund when THIS request is the one
    // that actually flipped the row. select() lets us see whether a row changed.
    // trash_origin_folder_id (migration 032) snapshots where the file lived so
    // POST /trash/:id/restore can put it back (FK nulls it if the folder goes).
    const { data: deletedRows, error } = await app.supabase
      .from('files')
      .update({ deleted_at: new Date().toISOString(), trash_origin_folder_id: file.folder_id })
      .eq('id', file.id)
      .is('deleted_at', null)
      .select('id');
    if (error) throw error;

    // No row changed → the file was already soft-deleted by a concurrent
    // request. Idempotent success, and crucially DO NOT refund again.
    if (!deletedRows || deletedRows.length === 0) {
      return reply.code(204).send();
    }

    // Return the freed space to the ledger that was actually CHARGED
    // (files.charged_to / charged_team_id, migration 015). team_id is not a
    // reliable ledger key: deleteTeam nulls it, which used to make the refund
    // fall through to the uploader's personal quota — quota that was never
    // charged for a team file. Rows predating migration 015 have no ledger
    // stamp (backfill best-effort), so team_id remains the legacy fallback.
    // (adjustStorageUsed also re-arms the storage alert once usage drops back
    // under the reset line.)
    if (file.file_size > 0) {
      const chargedTo = file.charged_to ?? (file.team_id ? 'team' : 'personal');
      if (chargedTo === 'team') {
        const chargedTeamId = file.charged_team_id ?? file.team_id ?? null;
        if (chargedTeamId) {
          // Refund the team — even a soft-deleted one (harmless counter update;
          // the uploader's personal quota must never receive this refund).
          await incrementTeamStorage(app.supabase, chargedTeamId, -file.file_size, { enforce: false });
        }
        // charged team unknown (hard-deleted row) → the quota is already gone
        // with the team; refund no one.
      } else if (file.uploaded_by) {
        await adjustStorageUsed(app.supabase, file.uploaded_by, -file.file_size, file.space_id);
      }
    }
    return reply.code(204).send();
  });
};

export default filesRoutes;
