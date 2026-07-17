import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import multipart from '@fastify/multipart';
import sharp from 'sharp';
import { z } from 'zod';
import type { LegacyBoxThemeId, LegacyBoxOpenResponse, LegacyBoxListResponse } from '@nookeb/shared';
import { getStickerLayout, isThemeId } from '@nookeb/shared';
import { logEvent } from '../services/events.service';
import { presignedGetUrl, uploadStream, deleteObject } from '../services/r2.service';
import { adjustStorageUsed, incrementPersonalStorage } from '../services/file.service';
import {
  buildLegacyBoxPhotoKey,
  countLiveBoxes,
  deleteBoxRow,
  getBoxBySlug,
  getOwnedBox,
  insertBox,
  insertPhotos,
  legacyBoxShareUrl,
  listBoxes,
  listPhotos,
  listPhotosForBoxes,
  softDeleteBox,
  themeIdOf,
  toLegacyBoxDto,
} from '../services/legacy-box.service';

/**
 * กล่องของขวัญ (Legacy Box) API — migration 033. A box is 1–10 photos + a
 * message behind a public slug URL (`/box/{slug}` on the web), revealed with a
 * gift-opening animation. Web-only, isolated from the space/file model.
 *
 * Public surface: ONLY GET /legacy-box/open/:slug (the slug is the credential,
 * same trust model as routes/share.ts). It never returns user_id, the creator's
 * LINE name, or any other PII; responses are no-store + noindex, and it carries
 * its own tighter per-IP rate limit.
 *
 * Photos: re-encoded through sharp to bounded webp BEFORE storage — EXIF
 * (incl. GPS) is stripped because we never call .withMetadata(). Bytes are
 * charged to users.storage_used with up-front enforcement (reserve → store),
 * and refunded at SOFT delete (unlike the vault): a deleted box's photos are
 * unreachable from that moment — nothing can restore it — so the user gets
 * their quota back immediately while the purge sweep lags up to 7 days.
 */

const MAX_BOXES_PER_USER = 10;
const MAX_PHOTOS_PER_BOX = 10;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024; // per original photo, pre-compression
/** presigned TTL for the owner list's cover thumbnails */
const COVER_PRESIGN_TTL_SECONDS = 60;
/** presigned TTL for the public open page — short on purpose; regenerated per load */
const OPEN_PRESIGN_TTL_SECONDS = 120;

const ALLOWED_SOURCE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const fieldsSchema = z.object({
  title: z.string().trim().min(1).max(60).default('กล่องของขวัญ'),
  message: z.string().max(500).default(''),
  theme: z.string().refine(isThemeId, 'unknown theme').default('rose'),
});

const idParamSchema = z.string().uuid();

const reorderBodySchema = z.object({
  photoIds: z.array(z.string().uuid()).min(1).max(MAX_PHOTOS_PER_BOX),
});

const legacyBoxRoutes: FastifyPluginAsync = async (app) => {
  // Multipart is scoped to this plugin, same as the vault's registration.
  await app.register(multipart, {
    limits: { fileSize: MAX_SOURCE_BYTES, files: MAX_PHOTOS_PER_BOX, fields: 5 },
  });

  // Auth on every route EXCEPT the public open endpoint (the slug is the credential).
  app.addHook('preHandler', async (request, reply) => {
    if (request.method === 'GET' && request.routeOptions.url === '/legacy-box/open/:slug') {
      return;
    }
    return app.authenticate(request, reply);
  });

  // POST /legacy-box — create a box from multipart (title/message/theme + photos).
  app.post('/legacy-box', async (request, reply) => {
    const userId = request.authUser!.userId;

    if ((await countLiveBoxes(app.supabase, userId)) >= MAX_BOXES_PER_USER) {
      return reply.code(429).send({
        error: `คุณมีกล่องของขวัญครบ ${MAX_BOXES_PER_USER} กล่องแล้ว`,
        code: 'BOX_LIMIT_REACHED',
      });
    }

    // Drain the multipart stream: buffer each photo and run it through sharp
    // right away (bounded resize + webp re-encode; EXIF/GPS stripped because
    // .withMetadata() is never called). Buffering is unavoidable here — sharp
    // needs the whole image — and bounded by the 20 MB per-file multipart limit.
    const fields: Record<string, string> = {};
    const photos: { webp: Buffer }[] = [];
    for await (const part of request.parts()) {
      if (part.type === 'field') {
        if (typeof part.value === 'string') fields[part.fieldname] = part.value;
        continue;
      }
      if (photos.length >= MAX_PHOTOS_PER_BOX) {
        part.file.resume(); // drain past the cap (multipart's own files limit backstops)
        continue;
      }
      if (!ALLOWED_SOURCE_MIME.has(part.mimetype)) {
        return reply.code(415).send({
          error: 'รองรับเฉพาะรูปภาพ (JPG, PNG, WebP, GIF)',
          code: 'UNSUPPORTED_PHOTO_TYPE',
        });
      }
      const source = await part.toBuffer();
      if (part.file.truncated) {
        // multipart truncates silently at the fileSize limit instead of erroring
        return reply.code(413).send({
          error: 'รูปใหญ่เกิน 20 MB ต่อรูป',
          code: 'PHOTO_TOO_LARGE',
        });
      }
      let webp: Buffer;
      try {
        webp = await sharp(source)
          .rotate() // bake EXIF orientation in before the metadata is dropped
          .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 82 })
          .toBuffer();
      } catch {
        return reply.code(415).send({
          error: 'ไฟล์รูปเสียหายหรือเปิดไม่ได้',
          code: 'PHOTO_UNREADABLE',
        });
      }
      photos.push({ webp });
    }

    if (photos.length === 0) {
      return reply.code(400).send({ error: 'ต้องมีรูปอย่างน้อย 1 รูป', code: 'NO_PHOTOS' });
    }

    const parsedFields = fieldsSchema.safeParse(fields);
    if (!parsedFields.success) {
      return reply
        .code(400)
        .send({ error: 'ข้อมูลกล่องไม่ถูกต้อง', issues: parsedFields.error.issues });
    }
    const { title, message } = parsedFields.data;
    const theme = parsedFields.data.theme as LegacyBoxThemeId;

    // RESERVE quota before anything hits R2 (rule 8's atomic path, enforced) —
    // exact bytes, since the webp buffers already exist. Everything after this
    // point refunds on failure.
    const totalBytes = photos.reduce((sum, p) => sum + p.webp.length, 0);
    const reservation = await incrementPersonalStorage(app.supabase, userId, totalBytes, {
      enforce: true,
    });
    if (reservation.overLimit) {
      void logEvent(app.supabase, {
        eventType: 'feature_blocked_quota',
        userId,
        source: 'web',
        metadata: { feature: 'legacy_box', bytes: totalBytes },
      });
      return reply.code(409).send({ error: 'พื้นที่ไม่เพียงพอ', code: 'QUOTA_EXCEEDED' });
    }

    const boxId = randomUUID();
    const uploadedKeys: string[] = [];
    let boxRowCreated = false;
    try {
      const photoRows = [];
      for (const [i, photo] of photos.entries()) {
        const key = buildLegacyBoxPhotoKey(userId, boxId, randomUUID());
        await uploadStream(app.r2, key, Readable.from(photo.webp), 'image/webp');
        uploadedKeys.push(key);
        photoRows.push({
          box_id: boxId,
          r2_key: key,
          mime_type: 'image/webp',
          file_size: photo.webp.length,
          sort_order: i,
        });
      }
      const box = await insertBox(app.supabase, {
        id: boxId,
        userId,
        title,
        message,
        theme,
        totalBytes,
      });
      boxRowCreated = true;
      await insertPhotos(app.supabase, photoRows);

      void logEvent(app.supabase, {
        eventType: 'box_created',
        userId,
        source: 'web',
        metadata: { photos: photos.length, bytes: totalBytes },
      });
      return reply.code(201).send({ id: box.id, slug: box.slug, shareUrl: legacyBoxShareUrl(box.slug) });
    } catch (err) {
      // Full rollback: objects, the (never-published) box row, and the quota
      // reservation. The row hard-delete is fine here — it existed only inside
      // this failed request; tombstoning applies to published boxes.
      for (const key of uploadedKeys) {
        await deleteObject(app.r2, key).catch(() => {});
      }
      if (boxRowCreated) await deleteBoxRow(app.supabase, boxId).catch(() => {});
      await adjustStorageUsed(app.supabase, userId, -totalBytes).catch((refundErr) =>
        request.log.error({ err: refundErr, userId, totalBytes }, 'legacy-box: rollback refund failed'),
      );
      throw err;
    }
  });

  // GET /legacy-box — the caller's live boxes, newest first, with cover thumbnails.
  app.get('/legacy-box', async (request): Promise<LegacyBoxListResponse> => {
    const userId = request.authUser!.userId;
    const boxes = await listBoxes(app.supabase, userId);
    const photosByBox = await listPhotosForBoxes(
      app.supabase,
      boxes.map((b) => b.id),
    );
    const dtos = await Promise.all(
      boxes.map(async (box) => {
        const boxPhotos = photosByBox.get(box.id) ?? [];
        const cover = boxPhotos[0];
        const coverUrl = cover
          ? await presignedGetUrl(app.r2, cover.r2_key, undefined, COVER_PRESIGN_TTL_SECONDS)
          : null;
        return toLegacyBoxDto(box, boxPhotos.length, coverUrl);
      }),
    );
    return {
      boxes: dtos,
      total: dtos.length,
      totalViews: dtos.reduce((sum, b) => sum + b.viewCount, 0),
    };
  });

  // DELETE /legacy-box/:id — soft delete + immediate quota refund (see header).
  app.delete<{ Params: { id: string } }>('/legacy-box/:id', async (request, reply) => {
    const parsedId = idParamSchema.safeParse(request.params.id);
    if (!parsedId.success) return reply.code(400).send({ error: 'รหัสกล่องไม่ถูกต้อง' });
    const userId = request.authUser!.userId;

    const box = await getOwnedBox(app.supabase, userId, parsedId.data);
    if (!box) return reply.code(404).send({ error: 'ไม่พบกล่องของขวัญนี้' });

    // Affected-rows guard: only the request that actually flipped deleted_at
    // performs the refund, so a double-tap can't refund twice.
    const flipped = await softDeleteBox(app.supabase, userId, box.id);
    if (!flipped) return reply.code(404).send({ error: 'ไม่พบกล่องของขวัญนี้' });

    // Best-effort refund (undercounts on failure — the safe direction).
    try {
      await adjustStorageUsed(app.supabase, userId, -Number(box.total_bytes));
    } catch (err) {
      request.log.error({ err, userId, boxId: box.id }, 'legacy-box: delete refund failed');
    }

    void logEvent(app.supabase, {
      eventType: 'box_deleted',
      userId,
      source: 'web',
      metadata: { bytes: Number(box.total_bytes) },
    });
    return { success: true };
  });

  // PATCH /legacy-box/:id/reorder — set a new photo order (owner only).
  app.patch<{ Params: { id: string } }>('/legacy-box/:id/reorder', async (request, reply) => {
    const parsedId = idParamSchema.safeParse(request.params.id);
    if (!parsedId.success) return reply.code(400).send({ error: 'รหัสกล่องไม่ถูกต้อง' });
    const parsedBody = reorderBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: 'ลำดับรูปไม่ถูกต้อง', issues: parsedBody.error.issues });
    }
    const userId = request.authUser!.userId;

    const box = await getOwnedBox(app.supabase, userId, parsedId.data);
    if (!box) return reply.code(404).send({ error: 'ไม่พบกล่องของขวัญนี้' });

    // The ordered ids must be exactly this box's photos — no missing, no foreign.
    const photos = await listPhotos(app.supabase, box.id);
    const ownIds = new Set(photos.map((p) => p.id));
    const requested = parsedBody.data.photoIds;
    if (requested.length !== ownIds.size || !requested.every((id) => ownIds.has(id))) {
      return reply.code(400).send({ error: 'ลำดับรูปไม่ครบหรือไม่ตรงกับกล่องนี้' });
    }

    for (const [index, photoId] of requested.entries()) {
      const { error } = await app.supabase
        .from('legacy_box_photos')
        .update({ sort_order: index })
        .eq('id', photoId)
        .eq('box_id', box.id);
      if (error) throw error;
    }
    return { success: true };
  });

  // GET /legacy-box/open/:slug — PUBLIC (the recipient's reveal page).
  //
  // `?preview=1` is a NON-COUNTING read: same payload, but no view tick and no
  // box_viewed event. It exists for the web's generateMetadata (OG image theme
  // lookup), which runs on every request to /box/:slug — including unfurl bots
  // (LINE/Facebook/iMessage) that never open the box, and once more alongside
  // the real client fetch on every genuine open. Counting those would double
  // every real view and invent views that never happened.
  app.get<{ Params: { slug: string }; Querystring: { preview?: string } }>(
    '/legacy-box/open/:slug',
    {
      config: {
        // Tighter than the 100/min global limit — this is the only unauthenticated
        // enumeration surface (slug guessing) the feature exposes. preview reads
        // share this limit: not counting a view is not a reason to allow probing.
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply): Promise<LegacyBoxOpenResponse | void> => {
      // Gift links are private surprises — never cacheable, never indexed.
      reply.header('X-Robots-Tag', 'noindex, nofollow');
      reply.header('Cache-Control', 'no-store');

      const box = await getBoxBySlug(app.supabase, request.params.slug);
      if (!box) return reply.code(404).send({ error: 'not_found' });

      const isPreview = request.query.preview === '1';

      if (!isPreview) {
        // Fire-and-forget atomic view count — a failed tick must not block the reveal.
        void app.supabase
          .rpc('increment_box_views', { p_box_id: box.id })
          .then(({ error }) => {
            if (error) request.log.warn({ err: error }, 'increment_box_views failed');
          });
        void logEvent(app.supabase, {
          eventType: 'box_viewed',
          userId: box.user_id,
          source: 'web',
          metadata: { views: box.view_count + 1 },
        });
      }

      const photos = await listPhotos(app.supabase, box.id);
      const signed = await Promise.all(
        photos.map(async (p) => ({
          url: await presignedGetUrl(app.r2, p.r2_key, undefined, OPEN_PRESIGN_TTL_SECONDS),
          sortOrder: p.sort_order,
        })),
      );

      // NO user_id / creator name / PII — the response is exactly this shape.
      return {
        title: box.title,
        message: box.message,
        theme: themeIdOf(box),
        photos: signed,
        stickerLayout: getStickerLayout(box.slug),
        // a preview read didn't tick the counter, so don't pretend it did
        viewCount: isPreview ? box.view_count : box.view_count + 1,
      };
    },
  );
};

export default legacyBoxRoutes;
