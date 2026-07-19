import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

/**
 * Pro-tier demand tests (fake-door tests). Two DISTINCT surfaces live here:
 *
 * 1. POST /api/pro-interest — the gift-box create flow (migration 034). Two
 *    locked entries (เพิ่มเสียง/เพลง, แนบวิดีโอสั้น) and a tap on "แจ้งเตือนฉัน"
 *    lands here. UNAUTHENTICATED by design (the create flow is a public
 *    surface), which shapes everything: it records only THAT someone tapped —
 *    no user_id, no IP, no session — carries its own tight per-IP limit (the one
 *    unauthenticated INSERT in the app), and returns an identical
 *    { success: true } to everyone. The counts are directional interest, not
 *    per-user truth; never build anything identity-bearing on pro_interest_log.
 *
 * 2. POST/GET /pro-interest — the ระบบตามงาน (Task Manager) LIFF pages
 *    (migration 040). Those pages ARE authenticated (LIFF id token -> app
 *    session cookie), so here we DO record who tapped and dedupe one record per
 *    (user_id, feature_id). This is what lets the admin dashboard compute a real
 *    per-feature conversion %. Writes to the SEPARATE `pro_interest` table —
 *    the anonymous gift-box log is left untouched.
 */

const anonBodySchema = z.object({
  feature: z.enum(['audio', 'video']),
});

const TASK_FEATURE_IDS = ['task_auto_reminder', 'task_voice_command'] as const;
const authedBodySchema = z.object({
  featureId: z.enum(TASK_FEATURE_IDS),
});

const proInterestRoutes: FastifyPluginAsync = async (app) => {
  // --- gift-box (anonymous) ---
  app.post(
    '/api/pro-interest',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = anonBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'ฟีเจอร์ไม่ถูกต้อง', code: 'INVALID_FEATURE' });
      }

      const { error } = await app.supabase
        .from('pro_interest_log')
        .insert({ feature: parsed.data.feature });
      if (error) {
        // A lost demand-test tap is not worth an error toast on a "we'll tell you
        // later" button — log it and let the user see the happy path.
        request.log.error({ err: error, feature: parsed.data.feature }, 'pro-interest: insert failed');
      }

      return { success: true };
    },
  );

  // --- Task Manager (authenticated, deduped) ---

  // Record interest in a task Pro feature. Idempotent: a repeat tap by the same
  // user for the same feature is a no-op (UNIQUE(user_id, feature_id) +
  // ON CONFLICT DO NOTHING), so unique clicks == unique interested users.
  app.post('/pro-interest', { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = authedBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'ฟีเจอร์ไม่ถูกต้อง', code: 'INVALID_FEATURE' });
    }

    const userId = request.authUser!.userId;
    const { error } = await app.supabase
      .from('pro_interest')
      .upsert(
        { user_id: userId, feature_id: parsed.data.featureId },
        { onConflict: 'user_id,feature_id', ignoreDuplicates: true },
      );
    if (error) {
      // Same posture as the anonymous test: don't fail a "we'll tell you later"
      // tap. The client's optimistic ✓ still shows; the record is best-effort.
      request.log.error({ err: error, featureId: parsed.data.featureId }, 'pro-interest(authed): upsert failed');
    }

    return { success: true };
  });

  // The set of task Pro features this user has already registered interest in —
  // lets the pages restore the "จะแจ้งเตือนน้า ✓" state across reloads.
  app.get('/pro-interest', { preHandler: app.authenticate }, async (request) => {
    const userId = request.authUser!.userId;
    const { data, error } = await app.supabase
      .from('pro_interest')
      .select('feature_id')
      .eq('user_id', userId);
    if (error) {
      request.log.error({ err: error }, 'pro-interest(authed): list failed');
      return { features: [] as string[] };
    }
    return { features: (data ?? []).map((r) => r.feature_id as string) };
  });
};

export default proInterestRoutes;
