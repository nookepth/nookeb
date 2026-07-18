import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { toGroupMemberDto } from '@nookeb/shared';
import { getChatMemberProfileStrict } from '../services/line.service';
import {
  ensureGroupMember,
  isGroupMember,
  listGroupMembers,
  syncGroupRoster,
  upsertGroupMember,
} from '../services/task.service';

/**
 * ระบบตามงาน group roster (migration 036). The roster fills itself three ways
 * (nobody needs to type /register — that command remains as a legacy alias):
 *  1. every group message auto-upserts its sender (webhook/line.ts);
 *  2. GET members below runs a throttled fetch-time sync against LINE's
 *     members/ids endpoint (verified OA) and re-resolves NULL names via the
 *     group-scoped profile endpoint (works for members who never friended
 *     the OA — the friend-only /v2/bot/profile endpoint was why names came
 *     back NULL before);
 *  3. opening any task page auto-enrolls the caller (ensureGroupMember).
 *
 * Trust model: a LINE group id is an unguessable capability (same model as
 * share links). The profile stored is always fetched server-side from LINE
 * (never client-supplied), and every task route re-checks this roster before
 * revealing anything.
 */

const groupIdSchema = z.string().min(1).max(100);

const groupsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (request, reply) => app.authenticate(request, reply));

  // GET /groups/:groupId/members — the LIFF assignee picker's roster.
  // Auto-enrolls the caller (LINE's group-scoped profile fetch doubles as a
  // membership check), then fills the roster from LINE before reading. 403
  // NOT_REGISTERED only when LINE can't place the caller in the group at all.
  app.get<{ Params: { groupId: string } }>('/groups/:groupId/members', async (request, reply) => {
    const parsed = groupIdSchema.safeParse(request.params.groupId);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid group id' });
    const groupId = parsed.data;
    const lineUid = request.authUser!.lineUserId;

    if (!(await ensureGroupMember(app.supabase, groupId, lineUid))) {
      return reply.code(403).send({
        error: 'ยังไม่เห็นเราในกลุ่มนี้เลยน้า ลองส่งข้อความในกลุ่มแล้วกดลองใหม่อีกที',
        code: 'NOT_REGISTERED',
      });
    }
    await syncGroupRoster(app.supabase, app.redis, groupId);
    const members = await listGroupMembers(app.supabase, groupId);
    return { members: members.map(toGroupMemberDto) };
  });

  // POST /groups/:groupId/register — self-register the caller (the LIFF calls
  // this on open so the task creator is on the roster without typing anything;
  // teammates still register by typing "/register" in the group chat).
  app.post<{ Params: { groupId: string } }>(
    '/groups/:groupId/register',
    async (request, reply) => {
      const parsed = groupIdSchema.safeParse(request.params.groupId);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid group id' });
      const lineUid = request.authUser!.lineUserId;

      // Already on the roster → idempotent success (no LINE round trip).
      if (await isGroupMember(app.supabase, parsed.data, lineUid)) {
        return reply.code(204).send();
      }

      // Profile from LINE, not from the request body — the roster's names and
      // avatars end up in group-visible Flex cards, so they must be authentic.
      // STRICT group-scoped fetch: it 404s for non-members, so a success is the
      // membership proof. Without this gate, ANY authenticated user could enroll
      // themselves into any groupId they learned and read/create its tasks.
      const profile = await getChatMemberProfileStrict(parsed.data, lineUid);
      if (!profile) {
        return reply.code(403).send({
          error: 'ยังไม่เห็นเราในกลุ่มนี้เลยน้า ลองส่งข้อความในกลุ่มแล้วกดลองใหม่อีกที',
          code: 'NOT_REGISTERED',
        });
      }
      await upsertGroupMember(
        app.supabase,
        parsed.data,
        lineUid,
        profile.displayName,
        profile.pictureUrl ?? null,
      );
      return reply.code(204).send();
    },
  );
};

export default groupsRoutes;
