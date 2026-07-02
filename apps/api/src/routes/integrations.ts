import type { FastifyPluginAsync } from 'fastify';
import jwt from 'jsonwebtoken';
import { Buffer } from 'node:buffer';
import { buffer as readAll } from 'node:stream/consumers';
import type { FileRecord } from '@nookeb/shared';
import { config, isDriveExportEnabled } from '../config';
import { getObjectStream } from '../services/r2.service';
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  refreshGoogleAccessToken,
  uploadToDrive,
} from '../services/google.service';
import { isSpaceMember } from '../services/file.service';

interface OAuthState {
  userId: string;
  kind: 'google_oauth';
}

const integrationsRoutes: FastifyPluginAsync = async (app) => {
  function ensureEnabled(reply: import('fastify').FastifyReply): boolean {
    if (!isDriveExportEnabled) {
      reply.code(503).send({ error: 'Google Drive export is not configured on the server' });
      return false;
    }
    return true;
  }

  // GET /integrations/google/status — is the user's Google account connected?
  app.get('/integrations/google/status', { preHandler: app.authenticate }, async (request) => {
    if (!isDriveExportEnabled) return { enabled: false, connected: false, email: null };
    const { data } = await app.supabase
      .from('google_accounts')
      .select('email')
      .eq('user_id', request.authUser!.userId)
      .maybeSingle();
    return { enabled: true, connected: Boolean(data), email: data?.email ?? null };
  });

  // GET /integrations/google/auth-url — start the OAuth flow
  app.get('/integrations/google/auth-url', { preHandler: app.authenticate }, async (request, reply) => {
    if (!ensureEnabled(reply)) return;
    const state = jwt.sign(
      { userId: request.authUser!.userId, kind: 'google_oauth' } satisfies OAuthState,
      config.JWT_SECRET,
      { expiresIn: '15m' },
    );
    return { url: buildGoogleAuthUrl(state) };
  });

  // GET /integrations/google/callback — Google redirects here (browser, no auth header)
  app.get<{ Querystring: { code?: string; state?: string } }>(
    '/integrations/google/callback',
    async (request, reply) => {
      if (!isDriveExportEnabled) return reply.code(503).send({ error: 'Not configured' });
      const { code, state } = request.query;
      if (!code || !state) return reply.code(400).send({ error: 'Missing code/state' });

      let userId: string;
      try {
        const decoded = jwt.verify(state, config.JWT_SECRET) as OAuthState;
        if (decoded.kind !== 'google_oauth') throw new Error('bad state');
        userId = decoded.userId;
      } catch {
        return reply.code(400).send({ error: 'Invalid or expired state' });
      }

      const { refreshToken, email } = await exchangeGoogleCode(code);
      if (!refreshToken) {
        return reply.redirect(`${config.WEB_URL}/dashboard?drive=error`);
      }
      const { error } = await app.supabase
        .from('google_accounts')
        .upsert({ user_id: userId, refresh_token: refreshToken, email, connected_at: new Date().toISOString() });
      if (error) throw error;

      return reply.redirect(`${config.WEB_URL}/dashboard?drive=connected`);
    },
  );

  // DELETE /integrations/google — disconnect
  app.delete('/integrations/google', { preHandler: app.authenticate }, async (request, reply) => {
    const { error } = await app.supabase
      .from('google_accounts')
      .delete()
      .eq('user_id', request.authUser!.userId);
    if (error) throw error;
    return reply.code(204).send();
  });

  // POST /files/:id/export/drive — copy a stored file into the user's Drive
  app.post<{ Params: { id: string } }>(
    '/files/:id/export/drive',
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (!ensureEnabled(reply)) return;
      const userId = request.authUser!.userId;

      const { data: acct, error: acctErr } = await app.supabase
        .from('google_accounts')
        .select('refresh_token')
        .eq('user_id', userId)
        .maybeSingle();
      if (acctErr) throw acctErr;
      if (!acct) return reply.code(409).send({ error: 'Google account not connected' });

      const { data: fileRow, error: fileErr } = await app.supabase
        .from('files')
        .select('*')
        .eq('id', request.params.id)
        .is('deleted_at', null)
        .maybeSingle();
      if (fileErr) throw fileErr;
      if (!fileRow) return reply.code(404).send({ error: 'File not found' });
      const file = fileRow as FileRecord;
      if (!(await isSpaceMember(app.supabase, file.space_id, userId))) {
        return reply.code(404).send({ error: 'File not found' });
      }
      if (file.status !== 'ready') {
        return reply.code(409).send({ error: `File not ready (status: ${file.status})` });
      }

      const accessToken = await refreshGoogleAccessToken(acct.refresh_token as string);
      const body = await readAll(await getObjectStream(app.r2, file.r2_key));
      const name = file.display_name ?? file.original_name;
      const result = await uploadToDrive(accessToken, name, file.mime_type, body);

      return { driveFileId: result.id, link: result.link };
    },
  );
};

export default integrationsRoutes;
