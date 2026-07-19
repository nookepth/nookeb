import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import argon2 from 'argon2';
import { z } from 'zod';
import { config } from '../config';
import { logEvent } from '../services/events.service';
import { getObjectStream, uploadStream, deleteObject } from '../services/r2.service';
import {
  byteRange,
  decryptStream,
  deriveUserKey,
  encryptStream,
  generateDek,
  generateFileIv,
  isVaultConfigured,
  unwrapDek,
  wrapDek,
} from '../services/vault-crypto';
import {
  VAULT_SESSION_TTL_SECONDS,
  checkVaultSession,
  clearFailedAttempts,
  closeVaultSession,
  getLockoutRemaining,
  openVaultSession,
  peekVaultSession,
  recordFailedAttempt,
} from '../services/vault-session.service';
import { adjustStorageUsed } from '../services/file.service';
import {
  buildVaultKey,
  getVaultFile,
  getVaultStats,
  insertVaultFile,
  listVaultFiles,
  softDeleteVaultFile,
  toVaultFileDto,
  watermarkImage,
} from '../services/vault.service';

/**
 * ห้องนิรภัย (Vault) — PIN-protected, view-only, per-user encrypted store.
 * Web-only: nothing in the LINE webhook/worker writes to vault_files.
 *
 * Guard chain: authenticate (plugin hook) → requireVaultPremium →
 * requireVaultSession. Lock states use 403 + a `code` the web switches on
 * ('VAULT_PREMIUM_REQUIRED' | 'VAULT_LOCKED') — NOT 401, which the web client
 * treats as "logged out" and would clear the whole session hint.
 *
 * View-side rules (the reason this feature exists):
 *  - NO download endpoint, NO presigned URLs — approved deviation from
 *    engineering rule 5: a presigned URL works for anyone holding it for its
 *    whole TTL, which is exactly the sharing vector the vault must close.
 *    All bytes stream through GET /vault/files/:id/view, re-checking
 *    ownership + unlock state per request.
 *  - Images are re-encoded with a tiled viewer-name+timestamp watermark.
 *  - Honest limit: none of this can stop a screenshot/screen recording —
 *    the watermark makes a leak traceable, not impossible.
 */

const GCM_TAG_BYTES = 16;

const VAULT_ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  'application/pdf',
]);

const pinSchema = z.object({ pin: z.string().regex(/^\d{6}$/, 'PIN must be exactly 6 digits') });

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const idParamSchema = z.string().uuid();

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MB
  timeCost: 3,
  parallelism: 1,
} as const;

interface VaultUserRow {
  vault_pin_hash: string | null;
  vault_plan: string;
  display_name: string | null;
}

const vaultRoutes: FastifyPluginAsync = async (app) => {
  const maxFileBytes = config.VAULT_MAX_FILE_SIZE_MB * 1024 * 1024;

  // Multipart is registered ONLY in this scope — the vault upload is the one
  // web upload in the app (everything else arrives via the LINE webhook).
  await app.register(multipart, {
    limits: { fileSize: maxFileBytes, files: 1, fields: 5 },
  });

  // Feature gate: without the master key nothing can be encrypted/decrypted.
  app.addHook('onRequest', async (_request, reply) => {
    if (!isVaultConfigured()) {
      return reply
        .code(503)
        .send({ error: 'Vault is not available', code: 'VAULT_NOT_CONFIGURED' });
    }
  });

  // Vault responses are sensitive and per-viewer — never cacheable, never indexed.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store, no-cache');
    reply.header('X-Robots-Tag', 'noindex');
    return payload;
  });

  app.addHook('preHandler', async (request, reply) => app.authenticate(request, reply));

  async function getVaultUser(userId: string): Promise<VaultUserRow | null> {
    const { data, error } = await app.supabase
      .from('users')
      .select('vault_pin_hash, vault_plan, display_name')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    return (data as VaultUserRow | null) ?? null;
  }

  // Premium gate (manual vault_plan flag until billing lands), cached in Redis
  // for 60s — same pattern as the session-version cache in middleware/auth.
  const planCacheKey = (userId: string): string => `vault_plan:${userId}`;
  async function requireVaultPremium(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const userId = request.authUser!.userId;
    let plan = await app.redis.get(planCacheKey(userId));
    if (plan === null) {
      const user = await getVaultUser(userId);
      plan = user?.vault_plan ?? 'free';
      await app.redis.set(planCacheKey(userId), plan, 'EX', 60);
    }
    if (plan !== 'premium') {
      await reply
        .code(403)
        .send({ error: 'Vault requires premium', code: 'VAULT_PREMIUM_REQUIRED' });
    }
  }

  // Unlock gate — slides the 15-min session TTL on every guarded call.
  async function requireVaultSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const { userId, sessionVersion } = request.authUser!;
    const open = await checkVaultSession(app.redis, userId, sessionVersion);
    if (!open) {
      await reply.code(403).send({ error: 'Vault is locked', code: 'VAULT_LOCKED' });
    }
  }

  const guarded = { preHandler: [requireVaultPremium, requireVaultSession] };

  // Shared PIN verification for unlock + delete: lockout first (429), then
  // argon2 verify; every failure feeds the same per-USER brute-force counter
  // (per-user, never per-IP — see vault-session.service header). Returns null
  // when it already sent a response.
  async function verifyPinOrReply(
    request: FastifyRequest,
    reply: FastifyReply,
    pin: string,
    context: 'unlock' | 'delete',
  ): Promise<boolean | null> {
    const userId = request.authUser!.userId;

    const lockedFor = await getLockoutRemaining(app.redis, userId);
    if (lockedFor > 0) {
      await reply.code(429).send({
        error: 'Too many wrong PINs — vault is temporarily locked',
        code: 'VAULT_PIN_LOCKED_OUT',
        retryAfterSeconds: lockedFor,
      });
      return null;
    }

    const user = await getVaultUser(userId);
    if (!user?.vault_pin_hash) {
      await reply.code(400).send({ error: 'Vault PIN not set', code: 'VAULT_PIN_NOT_SET' });
      return null;
    }

    if (await argon2.verify(user.vault_pin_hash, pin)) {
      await clearFailedAttempts(app.redis, userId);
      return true;
    }

    const failure = await recordFailedAttempt(app.redis, userId);
    void logEvent(app.supabase, {
      eventType: 'vault_unlock_failed',
      userId,
      source: 'web',
      metadata: { context, locked: failure.lockedForSeconds !== null },
    });
    await reply.code(401).send({
      error: 'Incorrect PIN',
      code: 'VAULT_PIN_INCORRECT',
      attemptsRemaining: failure.attemptsRemaining,
      ...(failure.lockedForSeconds !== null
        ? { retryAfterSeconds: failure.lockedForSeconds }
        : {}),
    });
    return false;
  }

  // POST /vault/setup-pin — first-time activation (authenticate only). Also
  // flips vault_plan to 'premium': the manual gate until billing lands.
  app.post('/vault/setup-pin', async (request, reply) => {
    const parsed = pinSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'PIN must be exactly 6 digits' });
    }
    const userId = request.authUser!.userId;

    const user = await getVaultUser(userId);
    if (!user) return reply.code(404).send({ error: 'User not found' });
    if (user.vault_pin_hash) {
      // No PIN change/reset flow yet — deliberate: a reset path is a bypass
      // path, and designing a safe one (re-auth + cooldown) is its own task.
      return reply.code(409).send({ error: 'Vault PIN is already set' });
    }

    const hash = await argon2.hash(parsed.data.pin, ARGON2_OPTIONS);
    const { error } = await app.supabase
      .from('users')
      .update({ vault_pin_hash: hash, vault_plan: 'premium' })
      .eq('id', userId)
      .is('vault_pin_hash', null); // races with a concurrent setup lose here
    if (error) throw error;
    await app.redis.set(planCacheKey(userId), 'premium', 'EX', 60);

    void logEvent(app.supabase, { eventType: 'vault_setup', userId, source: 'web' });
    return { success: true };
  });

  // POST /vault/unlock — PIN → 15-minute unlock session.
  app.post('/vault/unlock', async (request, reply) => {
    const parsed = pinSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'PIN must be exactly 6 digits' });
    }
    const ok = await verifyPinOrReply(request, reply, parsed.data.pin, 'unlock');
    if (ok !== true) return; // reply already sent

    const { userId, sessionVersion } = request.authUser!;
    await openVaultSession(app.redis, userId, sessionVersion);
    return { success: true, expiresIn: VAULT_SESSION_TTL_SECONDS };
  });

  // POST /vault/lock — explicit re-lock (also called by the web auto-lock timer).
  app.post('/vault/lock', async (request) => {
    await closeVaultSession(app.redis, request.authUser!.userId);
    return { success: true };
  });

  // GET /vault/session-status — drives the web page's 4 states. Non-sliding.
  app.get('/vault/session-status', async (request) => {
    const { userId, sessionVersion } = request.authUser!;
    const [user, expiresIn] = await Promise.all([
      getVaultUser(userId),
      peekVaultSession(app.redis, userId, sessionVersion),
    ]);
    return {
      hasPin: Boolean(user?.vault_pin_hash),
      isPremium: user?.vault_plan === 'premium',
      isUnlocked: expiresIn !== null,
      expiresIn,
    };
  });

  // POST /vault/upload — multipart, stream-encrypted straight to R2 (rule 3:
  // never buffered, never on disk). Stored ciphertext = plaintext + 16-byte tag.
  // Per-route cap (on top of the 100/min global): large multipart bodies +
  // per-view sharp watermarking make this CPU/memory-heavy, so 20/min per IP.
  app.post('/vault/upload', {
    ...guarded,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const mp = await request.file();
    if (!mp) return reply.code(400).send({ error: 'Missing file field' });
    if (!VAULT_ALLOWED_MIME.has(mp.mimetype)) {
      return reply.code(415).send({
        error: 'File type not allowed in vault',
        allowed: [...VAULT_ALLOWED_MIME],
      });
    }
    const userId = request.authUser!.userId;
    const fileId = randomUUID();
    const r2Key = buildVaultKey(userId, fileId);
    const originalFilename = (mp.filename || 'file').slice(0, 255);

    const [userKey, dek, fileIv] = [await deriveUserKey(userId), generateDek(), generateFileIv()];
    const { size: cipherSize } = await uploadStream(
      app.r2,
      r2Key,
      encryptStream(mp.file, dek, fileIv),
      'application/octet-stream', // ciphertext — the real mime lives in the DB row
      maxFileBytes + GCM_TAG_BYTES, // backstop; multipart's own fileSize limit hits first
    );

    // Multipart limit truncates silently instead of erroring — a truncated
    // object must never be stored as if complete.
    if (mp.file.truncated) {
      await deleteObject(app.r2, r2Key).catch((err) =>
        request.log.error({ err, r2Key }, 'vault: truncated-upload cleanup failed'),
      );
      return reply
        .code(413)
        .send({ error: `File exceeds the ${config.VAULT_MAX_FILE_SIZE_MB} MB vault limit` });
    }

    const fileSize = cipherSize - GCM_TAG_BYTES;
    let row;
    try {
      row = await insertVaultFile(app.supabase, {
        id: fileId,
        userId,
        r2Key,
        originalFilename,
        mimeType: mp.mimetype,
        fileSize,
        dekEncrypted: wrapDek(userKey, dek),
        iv: fileIv.toString('base64'),
      });
    } catch (err) {
      // No DB row → the object is unreachable; remove it rather than leak storage.
      // Scoped to the insert ALONE: past this point a live row owns the object,
      // and deleting it would leave a file that lists but 500s on view.
      await deleteObject(app.r2, r2Key).catch(() => {});
      throw err;
    }

    // Vault files share the user's single storage_used pool (they are NOT a
    // separate quota). Charged AFTER the row exists, so a failed insert can't
    // bill for bytes the user can't see; the matching refund happens at hard
    // purge, not soft delete — a soft-deleted file still occupies R2. Atomic
    // per rule 8. No spaceId: the vault is outside the space model, so the
    // storage-monitor alert has no space to report against.
    //
    // Best-effort: the file is already stored and listable, so a failed charge
    // must not fail the upload (the user would retry and store it twice). It
    // undercounts instead — the safe direction, and repairable by re-running
    // supabase/backfills/backfill_vault_storage.sql.
    //
    // Deliberately NOT enforcing the limit: the bytes are already in R2 by this
    // point, so a rejection here would have to delete-and-refund. A vault upload
    // can therefore push storage_used past storage_limit; the multipart fileSize
    // limit is its only hard cap. Accepted for now — LINE uploads reserve quota
    // up front (incrementPersonalStorage with enforce) and the vault should too,
    // once its UI can render a quota-exceeded state.
    try {
      await adjustStorageUsed(app.supabase, userId, fileSize);
    } catch (err) {
      request.log.error({ err, userId, fileId, fileSize }, 'vault: storage charge failed');
    }

    void logEvent(app.supabase, {
      eventType: 'vault_upload_done',
      userId,
      source: 'web',
      metadata: { bytes: fileSize, mime: mp.mimetype },
    });
    return reply.code(201).send(toVaultFileDto(row));
  });

  // GET /vault/stats — totals for the dashboard's vault card. Behind the same
  // guard chain as every other vault read, so a locked vault leaks no counts
  // (the web calls this only when session-status says isUnlocked).
  app.get('/vault/stats', guarded, async (request) =>
    getVaultStats(app.supabase, request.authUser!.userId),
  );

  // GET /vault/files — the grid listing. NEVER returns r2_key/dek_encrypted/iv
  // (toVaultFileDto is the only shape that leaves the API).
  app.get('/vault/files', guarded, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
    }
    const { page, limit } = parsed.data;
    const { rows, total } = await listVaultFiles(
      app.supabase,
      request.authUser!.userId,
      page,
      limit,
    );
    return { files: rows.map(toVaultFileDto), total, page, limit };
  });

  // GET /vault/files/:id/view — the ONLY way vault bytes leave the system.
  app.get<{ Params: { id: string } }>('/vault/files/:id/view', guarded, async (request, reply) => {
    const parsedId = idParamSchema.safeParse(request.params.id);
    if (!parsedId.success) return reply.code(400).send({ error: 'Invalid file id' });
    const userId = request.authUser!.userId;

    const row = await getVaultFile(app.supabase, userId, parsedId.data);
    if (!row) return reply.code(404).send({ error: 'Vault file not found' });

    const userKey = await deriveUserKey(userId);
    const dek = unwrapDek(userKey, row.dek_encrypted);
    const fileIv = Buffer.from(row.iv, 'base64');

    reply.header(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(row.original_filename)}`,
    );

    // Images (except GIF): decrypt → burn tiled watermark → re-encode. Buffered
    // in memory (sharp needs the whole image; capped by VAULT_MAX_FILE_SIZE_MB).
    if (row.mime_type.startsWith('image/') && row.mime_type !== 'image/gif') {
      const source = await getObjectStream(app.r2, row.r2_key);
      const chunks: Buffer[] = [];
      for await (const chunk of decryptStream(source, dek, fileIv)) {
        chunks.push(chunk as Buffer);
      }
      const user = await getVaultUser(userId);
      const watermarked = await watermarkImage(
        Buffer.concat(chunks),
        row.mime_type,
        user?.display_name ?? 'nookeb',
      );
      return reply.type(row.mime_type).send(watermarked);
    }

    // Video + GIF: stream decrypt as-is, with single-range support for seek.
    // GCM can't seek, so a range decrypts from byte 0 and slices — and a
    // partial read never reaches the auth tag (unverified; full reads verify).
    if (row.mime_type.startsWith('video/') || row.mime_type === 'image/gif') {
      reply.header('Accept-Ranges', 'bytes');
      const size = row.file_size;
      const rangeHeader = request.headers.range;
      const match = typeof rangeHeader === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader) : null;

      if (match && (match[1] || match[2])) {
        const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        if (!Number.isFinite(start) || start > end || start >= size) {
          return reply.code(416).header('Content-Range', `bytes */${size}`).send();
        }
        const source = await getObjectStream(app.r2, row.r2_key);
        const plain = decryptStream(source, dek, fileIv);
        const window = plain.pipe(byteRange(start, end - start + 1));
        // Once the window is served, stop pulling ciphertext from R2. The
        // response is already complete, so teardown errors are just noise —
        // swallow them rather than crash on an unhandled 'error'.
        window.on('close', () => {
          plain.on('error', () => {});
          source.destroy();
        });
        return reply
          .code(206)
          .header('Content-Range', `bytes ${start}-${end}/${size}`)
          .header('Content-Length', end - start + 1)
          .type(row.mime_type)
          .send(window);
      }

      const source = await getObjectStream(app.r2, row.r2_key);
      return reply
        .header('Content-Length', size)
        .type(row.mime_type)
        .send(decryptStream(source, dek, fileIv));
    }

    // PDF: decrypted inline stream. The browser's built-in viewer keeps its
    // save button, so PDFs have a weaker view-only story than images.
    // TODO: rasterize for full security (needs pdfium/mupdf — pdf-lib can't render).
    const source = await getObjectStream(app.r2, row.r2_key);
    return reply
      .header('Content-Length', row.file_size)
      .type(row.mime_type)
      .send(decryptStream(source, dek, fileIv));
  });

  // DELETE /vault/files/:id — destructive, so the PIN is re-verified (feeding
  // the same brute-force counter as unlock). Soft delete; the daily purge
  // hard-removes R2 object + row after VAULT_PURGE_RETENTION_DAYS.
  app.delete<{ Params: { id: string } }>('/vault/files/:id', guarded, async (request, reply) => {
    const parsedId = idParamSchema.safeParse(request.params.id);
    if (!parsedId.success) return reply.code(400).send({ error: 'Invalid file id' });
    const parsedBody = pinSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: 'PIN must be exactly 6 digits' });
    }
    const ok = await verifyPinOrReply(request, reply, parsedBody.data.pin, 'delete');
    if (ok !== true) return;

    const deleted = await softDeleteVaultFile(app.supabase, request.authUser!.userId, parsedId.data);
    if (!deleted) return reply.code(404).send({ error: 'Vault file not found' });
    return { success: true };
  });
};

export default vaultRoutes;
