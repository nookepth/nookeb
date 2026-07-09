import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  toDiaryEntryDto,
  type DiaryEntryDto,
  type DiaryStreakResponse,
  type DiaryTodayStatusResponse,
} from '@nookeb/shared';
import { presignedGetUrl } from '../services/r2.service';
import { incrementPersonalStorage } from '../services/file.service';
import {
  bangkokDateString,
  getAdjacentEntryDates,
  getEntryByDate,
  getNotificationSettings,
  getStreak,
  listEntriesByYear,
  softDeleteEntry,
  upsertNotificationSettings,
} from '../services/diary.service';

/**
 * ไดอารี่ 365 วัน (My Diary) API — migration 028. All routes are scoped to the
 * authenticated user (diary is personal-only, no space membership involved).
 * Entries are CREATED via the LINE chat flow ("ไดอารี่" → photo), matching how
 * every other upload enters this system — the web dashboard reads, deletes,
 * and manages reminder settings.
 *
 * Image access follows rule 5: presigned R2 URLs (1 hour), never proxied.
 */

const entriesQuerySchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100).optional(),
});

const dateParamSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const notificationBodySchema = z.object({
  notify_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  is_enabled: z.boolean(),
  timezone: z.string().min(1).max(100).default('Asia/Bangkok'),
});

const diaryRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (request, reply) => app.authenticate(request, reply));

  // GET /diary/entries?year=2026 — all live entries for the year, oldest first.
  // Feeds the 365-day grid: thumbnails presigned here (falling back to the full
  // image when a thumbnail is still missing, so the grid never shows a hole).
  app.get('/diary/entries', async (request, reply) => {
    const parsed = entriesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
    }
    const userId = request.authUser!.userId;
    const year = parsed.data.year ?? Number(bangkokDateString().slice(0, 4));

    const rows = await listEntriesByYear(app.supabase, userId, year);
    const entries: DiaryEntryDto[] = await Promise.all(
      rows.map(async (row) => ({
        ...toDiaryEntryDto(row),
        thumbnailUrl: await presignedGetUrl(app.r2, row.thumbnail_key ?? row.image_key),
      })),
    );
    return { entries, year, total: entries.length };
  });

  // GET /diary/streak — header stats for the dashboard.
  app.get('/diary/streak', async (request) => {
    const streak = await getStreak(app.supabase, request.authUser!.userId);
    const response: DiaryStreakResponse = streak;
    return response;
  });

  // GET /diary/today-status — has today (Bangkok) been recorded? Bundled with
  // the reminder settings so the banner check (notification Option C: in-app
  // banner, this project never pushes) is a single call.
  app.get('/diary/today-status', async (request) => {
    const userId = request.authUser!.userId;
    const entryDate = bangkokDateString();
    const [entry, notification] = await Promise.all([
      getEntryByDate(app.supabase, userId, entryDate),
      getNotificationSettings(app.supabase, userId),
    ]);
    const response: DiaryTodayStatusResponse = {
      submitted: entry !== null,
      entryDate,
      notification,
    };
    return response;
  });

  // GET /diary/entry/:date — single entry with the full presigned image, plus
  // prev/next entry dates for the page-flip viewer.
  app.get<{ Params: { date: string } }>('/diary/entry/:date', async (request, reply) => {
    const parsed = dateParamSchema.safeParse(request.params.date);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid date — expected YYYY-MM-DD' });
    }
    const userId = request.authUser!.userId;
    const entry = await getEntryByDate(app.supabase, userId, parsed.data);
    if (!entry) return reply.code(404).send({ error: 'Diary entry not found' });

    const [imageUrl, thumbnailUrl, adjacent] = await Promise.all([
      presignedGetUrl(app.r2, entry.image_key),
      entry.thumbnail_key ? presignedGetUrl(app.r2, entry.thumbnail_key) : Promise.resolve(null),
      getAdjacentEntryDates(app.supabase, userId, entry.entry_date),
    ]);
    return {
      ...toDiaryEntryDto(entry),
      imageUrl,
      thumbnailUrl,
      prevDate: adjacent.prev,
      nextDate: adjacent.next,
    };
  });

  // DELETE /diary/entry/:id — soft delete (rule 6) + personal-quota refund.
  // The R2 objects are purged by the daily purge job after the retention window
  // (see purgeDeletedDiaryEntries). The refund is gated on THIS request being
  // the one that flipped deleted_at, so concurrent deletes can't double-refund.
  app.delete<{ Params: { id: string } }>('/diary/entry/:id', async (request, reply) => {
    const parsed = z.string().uuid().safeParse(request.params.id);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid entry id' });
    const userId = request.authUser!.userId;

    const deleted = await softDeleteEntry(app.supabase, userId, parsed.data);
    // Not found / not owned / already deleted → idempotent success for the
    // already-deleted case is indistinguishable here; report 404 only when the
    // caller never owned a live row (matches DELETE /files/:id semantics).
    if (!deleted) return reply.code(404).send({ error: 'Diary entry not found' });

    if (deleted.file_size > 0) {
      await incrementPersonalStorage(app.supabase, userId, -deleted.file_size, { enforce: false });
    }
    return reply.code(204).send();
  });

  // PUT /diary/notification — reminder preferences (in-app banner; this
  // project's LINE messaging is reply-only, so there is no scheduled push).
  app.put('/diary/notification', async (request, reply) => {
    const parsed = notificationBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }
    await upsertNotificationSettings(app.supabase, request.authUser!.userId, {
      notifyTime: parsed.data.notify_time,
      isEnabled: parsed.data.is_enabled,
      timezone: parsed.data.timezone,
    });
    return reply.code(204).send();
  });
};

export default diaryRoutes;
