import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { FileRecord } from '@nookeb/shared';
import { config } from '../config';
import { presignedGetUrl } from '../services/r2.service';
import { isSpaceMember } from '../services/file.service';

// Public share links (migration 027). A signed-in owner mints a link for one of
// their files (POST /files/:fileId/shares); anyone holding the token can view +
// download it WITHOUT logging in via the public GET /share/:token endpoint.
// Every route here except that public one requires the normal session JWT.

// Share URL TTL for the presigned R2 URLs handed to a public viewer — kept
// short (the token is the durable handle; the R2 URL is regenerated on each view).
const SHARE_PRESIGN_TTL_SECONDS = 60;

interface FileShareRow {
  id: string;
  file_id: string;
  created_by: string;
  token: string;
  expires_at: string | null;
  max_views: number | null;
  view_count: number;
  created_at: string;
}

interface ShareDto {
  id: string;
  token: string;
  shareUrl: string;
  expiresAt: string | null;
  maxViews: number | null;
  viewCount: number;
  createdAt: string;
}

const EXPIRES_IN = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  never: null,
} as const;

const createBodySchema = z.object({
  expiresIn: z.enum(['1h', '24h', '7d', 'never']),
});

function shareUrlFor(token: string): string {
  return `${config.WEB_URL}/share/${token}`;
}

function toShareDto(row: FileShareRow): ShareDto {
  return {
    id: row.id,
    token: row.token,
    shareUrl: shareUrlFor(row.token),
    expiresAt: row.expires_at,
    maxViews: row.max_views,
    viewCount: row.view_count,
    createdAt: row.created_at,
  };
}

const shareRoutes: FastifyPluginAsync = async (app) => {
  // Auth on every route EXCEPT the public viewer (GET /share/:token), which is
  // deliberately open — the token itself is the credential.
  app.addHook('preHandler', async (request, reply) => {
    const publicGet =
      request.method === 'GET' &&
      (request.routeOptions.url === '/share/:token' ||
        request.routeOptions.url === '/share/:token/download');
    if (publicGet) {
      return;
    }
    return app.authenticate(request, reply);
  });

  // Loads a file row and enforces space membership (same guard as routes/files.ts).
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

  // POST /files/:fileId/shares — mint a new public link for a file the caller owns.
  app.post<{ Params: { fileId: string } }>('/files/:fileId/shares', async (request, reply) => {
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'ระยะเวลาการแชร์ไม่ถูกต้อง', issues: parsed.error.issues });
    }

    const userId = request.authUser!.userId;
    const file = await getAuthorizedFile(request.params.fileId, userId);
    if (!file) return reply.code(404).send({ error: 'ไม่พบไฟล์นี้' });
    if (file.status !== 'ready') {
      return reply.code(409).send({ error: 'ไฟล์นี้ยังไม่พร้อมแชร์' });
    }

    const ttl = EXPIRES_IN[parsed.data.expiresIn];
    const expiresAt = ttl === null ? null : new Date(Date.now() + ttl).toISOString();

    // token/id/view_count come from DB defaults — never generated in the app layer.
    const { data, error } = await app.supabase
      .from('file_shares')
      .insert({ file_id: file.id, created_by: userId, expires_at: expiresAt })
      .select('*')
      .single();
    if (error) throw error;

    const dto = toShareDto(data as FileShareRow);
    return reply.code(201).send(dto);
  });

  // GET /files/:fileId/shares — list this file's shares (owner/member only).
  app.get<{ Params: { fileId: string } }>('/files/:fileId/shares', async (request, reply) => {
    const userId = request.authUser!.userId;
    const file = await getAuthorizedFile(request.params.fileId, userId);
    if (!file) return reply.code(404).send({ error: 'ไม่พบไฟล์นี้' });

    const { data, error } = await app.supabase
      .from('file_shares')
      .select('*')
      .eq('file_id', file.id)
      .order('created_at', { ascending: false });
    if (error) throw error;

    return { shares: (data as FileShareRow[]).map(toShareDto) };
  });

  // DELETE /files/:fileId/shares/:shareId — revoke a link (creator only).
  app.delete<{ Params: { fileId: string; shareId: string } }>(
    '/files/:fileId/shares/:shareId',
    async (request, reply) => {
      const userId = request.authUser!.userId;

      const { data: deleted, error } = await app.supabase
        .from('file_shares')
        .delete()
        .eq('id', request.params.shareId)
        .eq('file_id', request.params.fileId)
        .eq('created_by', userId)
        .select('id');
      if (error) throw error;
      if (!deleted || deleted.length === 0) {
        return reply.code(404).send({ error: 'ไม่พบลิงก์แชร์นี้' });
      }
      return reply.code(204).send();
    },
  );

  // GET /share/:token — PUBLIC viewer resolver (no auth). Returns file metadata
  // plus short-lived presigned preview/download URLs.
  app.get<{ Params: { token: string } }>('/share/:token', async (request, reply) => {
    const { token } = request.params;

    const { data: shareData, error: shareErr } = await app.supabase
      .from('file_shares')
      .select('*')
      .eq('token', token)
      .maybeSingle();
    if (shareErr) throw shareErr;
    if (!shareData) return reply.code(404).send({ error: 'not_found' });
    const share = shareData as FileShareRow;

    // Expiry: past expires_at, or the view cap has been reached → 410 Gone.
    const expired = share.expires_at !== null && new Date(share.expires_at).getTime() < Date.now();
    const viewsExhausted = share.max_views !== null && share.view_count >= share.max_views;
    if (expired || viewsExhausted) {
      return reply.code(410).send({ error: 'expired' });
    }

    const { data: fileData, error: fileErr } = await app.supabase
      .from('files')
      .select('*')
      .eq('id', share.file_id)
      .is('deleted_at', null)
      .maybeSingle();
    if (fileErr) throw fileErr;
    if (!fileData) return reply.code(404).send({ error: 'not_found' });
    const file = fileData as FileRecord;
    if (file.status !== 'ready') {
      return reply.code(404).send({ error: 'not_found' });
    }

    // Count the view atomically (best-effort — a failed increment must not block
    // viewing). The RPC avoids the read-modify-write race where concurrent
    // viewers all read the same view_count and overshoot max_views. Same pattern
    // as increment_box_views (migration 033); defined in migration 039.
    const { error: incErr } = await app.supabase.rpc('increment_share_views', {
      p_share_id: share.id,
    });
    if (incErr) {
      request.log.warn({ err: incErr }, 'file_shares view_count increment failed');
    }

    const fileName = file.display_name ?? file.original_name;
    const [previewUrl, downloadUrl] = await Promise.all([
      presignedGetUrl(app.r2, file.r2_key, undefined, SHARE_PRESIGN_TTL_SECONDS),
      presignedGetUrl(app.r2, file.r2_key, fileName, SHARE_PRESIGN_TTL_SECONDS),
    ]);

    return {
      fileName,
      fileSize: file.file_size,
      mimeType: file.mime_type,
      previewUrl,
      downloadUrl,
      expiresAt: share.expires_at,
    };
  });

  // GET /share/:token/download — PUBLIC. Re-mints a fresh presigned R2 download
  // URL on demand so a viewer who lingered past the short preview TTL can still
  // download (the page-load URL would have expired). Does NOT increment
  // view_count — that was already counted by GET /share/:token on page load.
  app.get<{ Params: { token: string } }>('/share/:token/download', async (request, reply) => {
    const { token } = request.params;

    const { data: shareData, error: shareErr } = await app.supabase
      .from('file_shares')
      .select('*')
      .eq('token', token)
      .maybeSingle();
    if (shareErr) throw shareErr;
    if (!shareData) return reply.code(404).send({ error: 'not_found' });
    const share = shareData as FileShareRow;

    // Mirror the expiry gate of GET /share/:token: an exhausted view cap must
    // also block downloads, otherwise a share that 410s on view keeps minting
    // fresh 1-hour download URLs forever.
    const expired = share.expires_at !== null && new Date(share.expires_at).getTime() < Date.now();
    const viewsExhausted = share.max_views !== null && share.view_count >= share.max_views;
    if (expired || viewsExhausted) {
      return reply.code(410).send({ error: 'expired' });
    }

    const { data: fileData, error: fileErr } = await app.supabase
      .from('files')
      .select('*')
      .eq('id', share.file_id)
      .is('deleted_at', null)
      .maybeSingle();
    if (fileErr) throw fileErr;
    if (!fileData) return reply.code(404).send({ error: 'not_found' });
    const file = fileData as FileRecord;
    if (file.status !== 'ready') {
      return reply.code(404).send({ error: 'not_found' });
    }

    const fileName = file.display_name ?? file.original_name;
    const downloadUrl = await presignedGetUrl(app.r2, file.r2_key, fileName, 3600);

    return { downloadUrl, fileName };
  });
};

export default shareRoutes;
