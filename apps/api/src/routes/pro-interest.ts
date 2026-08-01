import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

/**
 * Pro-tier demand test (fake-door test) for the gift-box create flow
 * (migration 034). Two locked entries (เพิ่มเสียง/เพลง, แนบวิดีโอสั้น) and a tap
 * on "แจ้งเตือนฉัน" lands here. UNAUTHENTICATED by design (the create flow is a
 * public surface), which shapes everything: it records only THAT someone
 * tapped — no user_id, no IP, no session — carries its own tight per-IP limit
 * (the one unauthenticated INSERT in the app), and returns an identical
 * { success: true } to everyone. The counts are directional interest, not
 * per-user truth; never build anything identity-bearing on pro_interest_log.
 *
 * The authenticated twin (POST/GET /pro-interest, migration 040) backed the two
 * ระบบตามงาน fake doors — task_auto_reminder / task_voice_command — and was
 * REMOVED with them. The `pro_interest` table and its historical rows are left
 * in place; only the write/read path and the allowed feature ids are gone.
 */

const anonBodySchema = z.object({
  feature: z.enum(['audio', 'video']),
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
};

export default proInterestRoutes;
