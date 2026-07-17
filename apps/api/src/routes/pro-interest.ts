import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

/**
 * Pro-tier demand test (migration 034). The create flow shows two locked
 * entries — เพิ่มเสียง/เพลง and แนบวิดีโอสั้น — and a tap on "แจ้งเตือนฉัน"
 * lands here. That is the entire feature: no audio/video upload exists, and
 * there is no billing.
 *
 * UNAUTHENTICATED by design (the spec's call), which shapes everything else:
 *
 * - It records only THAT someone tapped — no user_id, no IP, no session. An
 *   anonymous counter can't be de-anonymized later, and it can't leak: the only
 *   response is { success: true }, identical for every caller.
 * - It carries its own tight per-IP limit, like GET /legacy-box/open/:slug (the
 *   other public surface). Without it, the one unauthenticated INSERT in the app
 *   is an unbounded row-spam vector against the 100/min global limit.
 * - The counts are directional interest, not per-user truth — one person can tap
 *   twice, and nothing here can tell. Do not build anything that needs to
 *   identify a user on this table.
 */

const bodySchema = z.object({
  feature: z.enum(['audio', 'video']),
});

const proInterestRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/api/pro-interest',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = bodySchema.safeParse(request.body);
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
};

export default proInterestRoutes;
