import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  checkRedeemRateLimit,
  getReferralStatus,
  redeemCode,
} from '../services/referral.service';
import {
  sendRedeemSuccessToReferee,
  sendReferralProgressToReferrer,
} from '../services/referral.messages';
import { logEvent } from '../services/events.service';

const redeemBodySchema = z.object({
  code: z.string().regex(/^[a-zA-Z0-9]{1,8}$/),
});

const referralRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  // GET /referral/status — my code + tier progress (lazily assigns a code)
  app.get('/referral/status', async (request) => {
    return getReferralStatus(app.supabase, app.redis, request.authUser!.userId);
  });

  // POST /referral/redeem — redeem someone's code for the signed-in user
  app.post('/referral/redeem', async (request, reply) => {
    const parsed = redeemBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'โค้ดไม่ถูกต้อง' });
    }
    const userId = request.authUser!.userId;

    // Per-user attempt limit (3/hour) — the global limiter is IP-keyed and
    // wouldn't stop an authenticated user brute-forcing codes.
    if (!(await checkRedeemRateLimit(app.redis, userId))) {
      return reply.code(429).send({ message: 'ลองใหม่ใน 1 ชั่วโมง' });
    }

    // A code was submitted for redemption (the attempt — distinct from success).
    void logEvent(app.supabase, {
      eventType: 'referral_code_entered',
      userId,
      source: 'web',
    });

    const result = await redeemCode(app.supabase, app.redis, parsed.data.code, userId);
    if (!result.ok) {
      return { ok: false, message: result.reason };
    }

    // Redemption succeeded and the bonus was granted.
    void logEvent(app.supabase, {
      eventType: 'referral_code_activated',
      userId,
      source: 'web',
      metadata: { bonus_bytes: result.newStorageBytes ?? 0 },
    });

    // LINE pushes are best-effort — the redemption is already committed, so a
    // push failure must not turn the response into an error.
    try {
      await sendRedeemSuccessToReferee(app.supabase, userId, result.newStorageBytes!);
    } catch (err) {
      app.log.error({ err, userId }, 'referral: redeem-success push failed');
    }
    try {
      await sendReferralProgressToReferrer(app.supabase, app.redis, result.referrerId!);
    } catch (err) {
      app.log.error({ err, referrerId: result.referrerId }, 'referral: referrer progress push failed');
    }

    return { ok: true };
  });
};

export default referralRoutes;
