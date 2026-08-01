/**
 * บูธ (Group Boost) routes — §3.
 *
 * Middleware order: authenticate → planGuard('group_boost') → handler.
 * The slot COUNT is not a quotaCheck: boosts are a capacity limit backed by
 * live rows, claimed through the locking claim_group_boost RPC, so there is no
 * monthly counter to reserve.
 *
 * Tenant guard: every route verifies the caller is actually a member of the
 * LINE group before letting them boost it — holding a group id is a capability
 * in this codebase (CLAUDE.md §8), and `ensureGroupMember` is the same check
 * the task routes use.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { LINE_CHAT_ID_MESSAGE, LINE_CHAT_ID_RE } from '../services/line-id';
import { ensureGroupMember } from '../services/task.service';
import {
  boostGroup,
  getBoostStatus,
  releaseBoost,
  replaceBoost,
} from '../services/boost.service';
import { ensurePlan, planGuard } from '../middleware/planGuard';

const groupIdSchema = z.string().regex(LINE_CHAT_ID_RE, LINE_CHAT_ID_MESSAGE);

const boostBodySchema = z.object({ groupId: groupIdSchema });
const replaceBodySchema = z.object({
  fromGroupId: groupIdSchema,
  toGroupId: groupIdSchema,
});

/** Shared 403 body for a full slot set — names the occupants so the UI can offer a swap. */
function limitReachedBody(result: Extract<Awaited<ReturnType<typeof boostGroup>>, { ok: false }>) {
  return {
    error:
      result.code === 'BOOST_NOT_AVAILABLE'
        ? 'บูธกลุ่ม ใช้ได้กับแพ็กเกจ Pro ขึ้นไปน้า'
        : `แพ็กเกจนี้บูธได้สูงสุด ${result.limit} กลุ่มน้า ปลดบูธกลุ่มเดิมก่อนแล้วค่อยบูธกลุ่มใหม่ได้เลยน้า`,
    code: result.code,
    limit: result.limit,
    used: result.used,
    boostedGroupIds: result.liveGroupIds,
  };
}

const boostRoutes: FastifyPluginAsync = async (app) => {
  // ---- GET /boosts — slots, usage and what is currently boosted ----------
  // NOT plan-guarded: a free user must be able to see that they have 0 slots
  // and what upgrading would buy them.
  app.get('/boosts', { preHandler: app.authenticate }, async (request) => {
    const plan = await ensurePlan(request);
    return getBoostStatus(app.supabase, request.authUser!.userId, plan);
  });

  // ---- POST /boosts — activate ------------------------------------------
  app.post('/boosts', {
    preHandler: [app.authenticate, planGuard('group_boost')],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const parsed = boostBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }
    const { groupId } = parsed.data;
    const lineUid = request.authUser!.lineUserId;

    if (!(await ensureGroupMember(app.supabase, groupId, lineUid))) {
      return reply.code(403).send({
        error: 'ยังไม่เห็นเราในกลุ่มนี้เลยน้า ลองส่งข้อความในกลุ่มแล้วลองใหม่อีกที',
        code: 'NOT_REGISTERED',
      });
    }

    const plan = request.plan!;
    const result = await boostGroup(app.supabase, {
      userId: request.authUser!.userId,
      groupId,
      plan,
    });

    if (!result.ok) return reply.code(403).send(limitReachedBody(result));

    return reply.code(result.alreadyBoosted ? 200 : 201).send({
      boost: {
        groupId: result.boost.group_id,
        activatedAt: result.boost.activated_at,
        expiresAt: result.boost.expires_at,
      },
      alreadyBoosted: result.alreadyBoosted,
    });
  });

  // ---- DELETE /boosts/:groupId — un-boost --------------------------------
  // No plan guard: a user who downgraded must still be able to release a boost
  // they no longer have the entitlement to hold.
  app.delete<{ Params: { groupId: string } }>(
    '/boosts/:groupId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const parsed = groupIdSchema.safeParse(request.params.groupId);
      if (!parsed.success) {
        return reply.code(400).send({ error: LINE_CHAT_ID_MESSAGE });
      }
      const released = await releaseBoost(app.supabase, request.authUser!.userId, parsed.data);
      if (!released) {
        return reply.code(404).send({ error: 'ไม่พบบูธที่กำลังใช้งานของกลุ่มนี้น้า', code: 'BOOST_NOT_FOUND' });
      }
      return reply.send({ released: true, groupId: parsed.data });
    },
  );

  // ---- POST /boosts/replace — swap in one call ---------------------------
  // The "or replace if under limit" branch of the UX rule.
  app.post('/boosts/replace', {
    preHandler: [app.authenticate, planGuard('group_boost')],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const parsed = replaceBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }
    const { fromGroupId, toGroupId } = parsed.data;
    if (fromGroupId === toGroupId) {
      return reply.code(400).send({ error: 'กลุ่มเดิมกับกลุ่มใหม่ซ้ำกันน้า', code: 'SAME_GROUP' });
    }

    const lineUid = request.authUser!.lineUserId;
    if (!(await ensureGroupMember(app.supabase, toGroupId, lineUid))) {
      return reply.code(403).send({
        error: 'ยังไม่เห็นเราในกลุ่มนี้เลยน้า ลองส่งข้อความในกลุ่มแล้วลองใหม่อีกที',
        code: 'NOT_REGISTERED',
      });
    }

    const result = await replaceBoost(app.supabase, {
      userId: request.authUser!.userId,
      fromGroupId,
      toGroupId,
      plan: request.plan!,
    });

    if (!result.ok) return reply.code(403).send(limitReachedBody(result));

    return reply.send({
      boost: {
        groupId: result.boost.group_id,
        activatedAt: result.boost.activated_at,
        expiresAt: result.boost.expires_at,
      },
      replaced: fromGroupId,
    });
  });
};

export default boostRoutes;
