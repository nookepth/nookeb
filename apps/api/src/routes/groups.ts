import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { toGroupMemberDto } from '@nookeb/shared';
import { getProfile } from '../services/line.service';
import { isGroupMember, listGroupMembers, upsertGroupMember } from '../services/task.service';

/**
 * ระบบตามงาน group roster (migration 036). LINE's Messaging API cannot list
 * group members, so the assignee picker reads from group_members — an opt-in
 * roster users join by typing "/register" in the group (webhook path) or via
 * the LIFF self-register below.
 *
 * Trust model: a LINE group id is an unguessable capability (same model as
 * share links). Registering requires knowing the group id; the profile stored
 * is always fetched server-side from LINE (never client-supplied), and every
 * task route re-checks this roster before revealing anything.
 */

const groupIdSchema = z.string().min(1).max(100);

const groupsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (request, reply) => app.authenticate(request, reply));

  // GET /groups/:groupId/members — the LIFF assignee picker's roster. Only
  // registered members of the group may read it (403 NOT_REGISTERED tells the
  // LIFF to show the /register onboarding instead of a blank list).
  app.get<{ Params: { groupId: string } }>('/groups/:groupId/members', async (request, reply) => {
    const parsed = groupIdSchema.safeParse(request.params.groupId);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid group id' });
    const lineUid = request.authUser!.lineUserId;

    if (!(await isGroupMember(app.supabase, parsed.data, lineUid))) {
      return reply.code(403).send({
        error: 'ยังไม่ได้ลงทะเบียนในกลุ่มนี้ พิมพ์ /register ในกลุ่มก่อนน้า',
        code: 'NOT_REGISTERED',
      });
    }
    const members = await listGroupMembers(app.supabase, parsed.data);
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

      // Profile from LINE, not from the request body — the roster's names and
      // avatars end up in group-visible Flex cards, so they must be authentic.
      const profile = await getProfile(lineUid).catch(() => null);
      await upsertGroupMember(
        app.supabase,
        parsed.data,
        lineUid,
        profile?.displayName ?? null,
        profile?.pictureUrl ?? null,
      );
      return reply.code(204).send();
    },
  );
};

export default groupsRoutes;
