import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { toTeamDto, type TeamInviteDto, type TeamLineGroupDto } from '@nookeb/shared';
import { config } from '../config';
import {
  approveJoinRequest,
  bindLineGroup,
  createTeam,
  deleteTeam,
  getTeam,
  getTeamRole,
  inviteMember,
  listJoinRequests,
  listLineGroups,
  listPendingInvites,
  listUserTeams,
  rejectJoinRequest,
  removeMember,
  requestToJoin,
  TeamError,
  unbindLineGroup,
} from '../services/team.service';

/** Consistent envelope: { success: true, data } / { success: false, error, code } */
function ok<T>(reply: FastifyReply, data: T, status = 200) {
  return reply.code(status).send({ success: true, data });
}

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ success: false, error: message, code });
}

/**
 * Teams API — mounted at /api/teams (see index.ts).
 * All routes require the standard JWT auth; membership/role checks live in
 * team.service.ts, which throws TeamError with a stable code + status.
 */
const teamRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  // TeamError → { success: false, error, code }; everything else → 500
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof TeamError) {
      return fail(reply, err.statusCode, err.code, err.message);
    }
    request.log.error(err);
    return fail(reply, 500, 'INTERNAL', 'Something went wrong');
  });

  // POST /api/teams — create a team (creator becomes owner)
  app.post('/', async (request, reply) => {
    const parsed = z.object({ name: z.string().trim().min(1).max(120) }).safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'INVALID_BODY', 'Team name is required (1–120 chars)');

    const team = await createTeam(app.supabase, request.authUser!.userId, parsed.data.name);
    return ok(reply, toTeamDto(team, { role: 'owner', memberCount: 1 }), 201);
  });

  // GET /api/teams — all teams the user belongs to
  app.get('/', async (request, reply) => {
    const teams = await listUserTeams(app.supabase, request.authUser!.userId);
    return ok(
      reply,
      teams.map((t) => toTeamDto(t.team, { role: t.role, memberCount: t.memberCount })),
    );
  });

  // GET /api/teams/:teamId — team + members + storage + invites + LINE groups
  app.get<{ Params: { teamId: string } }>('/:teamId', async (request, reply) => {
    const userId = request.authUser!.userId;
    const { teamId } = request.params;
    const detail = await getTeam(app.supabase, teamId, userId);
    const [invites, groups] = await Promise.all([
      listPendingInvites(app.supabase, teamId, userId),
      listLineGroups(app.supabase, teamId, userId),
    ]);

    const inviteDtos: TeamInviteDto[] = invites.map((i) => ({
      id: i.id,
      token: i.token,
      status: i.status,
      expiresAt: i.expires_at,
      createdAt: i.created_at,
      invitedBy: i.invited_by,
    }));
    const groupDtos: TeamLineGroupDto[] = groups.map((g) => ({
      id: g.id,
      lineGroupId: g.line_group_id,
      boundBy: g.bound_by,
      createdAt: g.created_at,
    }));

    return ok(reply, {
      team: toTeamDto(detail.team, { role: detail.role, memberCount: detail.members.length }),
      members: detail.members,
      storage: detail.storage,
      invites: inviteDtos,
      lineGroups: groupDtos,
    });
  });

  // DELETE /api/teams/:teamId — owner-only soft delete
  app.delete<{ Params: { teamId: string } }>('/:teamId', async (request, reply) => {
    await deleteTeam(app.supabase, request.params.teamId, request.authUser!.userId);
    return ok(reply, { deleted: true });
  });

  // POST /api/teams/:teamId/invite — owner/admin mints a 7-day invite link
  app.post<{ Params: { teamId: string } }>('/:teamId/invite', async (request, reply) => {
    const invite = await inviteMember(app.supabase, request.params.teamId, request.authUser!.userId);
    return ok(
      reply,
      {
        token: invite.token,
        url: `${config.WEB_URL}/join?team_invite=${encodeURIComponent(invite.token)}`,
        expiresAt: invite.expires_at,
      },
      201,
    );
  });

  // POST /api/teams/invite/:token/accept — raise a join request (owner approves)
  app.post<{ Params: { token: string } }>('/invite/:token/accept', async (request, reply) => {
    const result = await requestToJoin(app.supabase, request.params.token, request.authUser!.userId);
    return ok(reply, result);
  });

  // GET /api/teams/:teamId/requests — owner/admin lists pending join requests
  app.get<{ Params: { teamId: string } }>('/:teamId/requests', async (request, reply) => {
    const requests = await listJoinRequests(
      app.supabase,
      request.params.teamId,
      request.authUser!.userId,
    );
    return ok(reply, requests);
  });

  // POST /api/teams/:teamId/requests/:id/approve — owner/admin approves → adds member
  app.post<{ Params: { teamId: string; id: string } }>(
    '/:teamId/requests/:id/approve',
    async (request, reply) => {
      await approveJoinRequest(app.supabase, request.params.id, request.authUser!.userId);
      return ok(reply, { approved: true });
    },
  );

  // POST /api/teams/:teamId/requests/:id/reject — owner/admin rejects
  app.post<{ Params: { teamId: string; id: string } }>(
    '/:teamId/requests/:id/reject',
    async (request, reply) => {
      await rejectJoinRequest(app.supabase, request.params.id, request.authUser!.userId);
      return ok(reply, { rejected: true });
    },
  );

  // DELETE /api/teams/:teamId/members/:userId — remove a member.
  // Owner/admin can remove others; any member can remove THEMSELVES (leave the
  // team). The owner can't leave — they must delete the team instead.
  app.delete<{ Params: { teamId: string; userId: string } }>(
    '/:teamId/members/:userId',
    async (request, reply) => {
      const requesterId = request.authUser!.userId;
      const { teamId, userId } = request.params;

      if (userId === requesterId) {
        const role = await getTeamRole(app.supabase, teamId, requesterId);
        if (!role) return fail(reply, 404, 'NOT_FOUND', 'Member not found');
        if (role === 'owner') {
          return fail(reply, 400, 'OWNER_CANNOT_LEAVE', 'The owner must delete the team instead of leaving');
        }
        const { error } = await app.supabase
          .from('team_members')
          .delete()
          .eq('team_id', teamId)
          .eq('user_id', requesterId);
        if (error) throw error;
        return ok(reply, { removed: true });
      }

      await removeMember(app.supabase, teamId, userId, requesterId);
      return ok(reply, { removed: true });
    },
  );

  // POST /api/teams/:teamId/groups — bind a LINE group to the team
  app.post<{ Params: { teamId: string } }>('/:teamId/groups', async (request, reply) => {
    const parsed = z.object({ lineGroupId: z.string().trim().min(1) }).safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'INVALID_BODY', 'lineGroupId is required');

    const binding = await bindLineGroup(
      app.supabase,
      request.params.teamId,
      parsed.data.lineGroupId,
      request.authUser!.userId,
    );
    return ok(
      reply,
      {
        id: binding.id,
        lineGroupId: binding.line_group_id,
        boundBy: binding.bound_by,
        createdAt: binding.created_at,
      } satisfies TeamLineGroupDto,
      201,
    );
  });

  // DELETE /api/teams/:teamId/groups/:groupId — owner/admin unbinds a LINE group
  app.delete<{ Params: { teamId: string; groupId: string } }>(
    '/:teamId/groups/:groupId',
    async (request, reply) => {
      await unbindLineGroup(
        app.supabase,
        request.params.teamId,
        request.params.groupId,
        request.authUser!.userId,
      );
      return ok(reply, { unbound: true });
    },
  );
};

export default teamRoutes;
