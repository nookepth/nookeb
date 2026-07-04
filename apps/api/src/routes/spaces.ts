import type { FastifyPluginAsync } from 'fastify';
import {
  toSpaceDto,
  type SpaceDto,
  type SpaceMemberDto,
  type SpaceRecord,
  type SpaceRole,
} from '@nookeb/shared';
import { getMemberRole } from '../services/space.service';

// Team creation / invites / joins moved to /api/teams (see team.router.ts).
// This module keeps only the read endpoints the dashboard still uses to list
// spaces and their members.
const spacesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  // GET /spaces — every space the user belongs to, with their role
  app.get('/spaces', async (request) => {
    const userId = request.authUser!.userId;
    const { data, error } = await app.supabase
      .from('space_members')
      .select('role, spaces!inner(*)')
      .eq('user_id', userId);
    if (error) throw error;

    const spaces: SpaceDto[] = (data as unknown as { role: SpaceRole; spaces: SpaceRecord }[]).map(
      (row) => toSpaceDto(row.spaces, row.role),
    );
    // personal first, then teams by name
    spaces.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'personal' ? -1 : 1));
    return { spaces };
  });

  // GET /spaces/:id/members — members of a space (must be a member)
  app.get<{ Params: { id: string } }>('/spaces/:id/members', async (request, reply) => {
    const userId = request.authUser!.userId;
    if (!(await getMemberRole(app.supabase, request.params.id, userId))) {
      return reply.code(403).send({ error: 'Not a member of this space' });
    }

    const { data, error } = await app.supabase
      .from('space_members')
      .select('role, joined_at, users!inner(id, display_name, picture_url)')
      .eq('space_id', request.params.id);
    if (error) throw error;

    const members: SpaceMemberDto[] = (
      data as unknown as {
        role: SpaceRole;
        joined_at: string;
        users: { id: string; display_name: string | null; picture_url: string | null };
      }[]
    ).map((m) => ({
      userId: m.users.id,
      role: m.role,
      displayName: m.users.display_name,
      pictureUrl: m.users.picture_url,
      joinedAt: m.joined_at,
    }));
    return { members };
  });
};

export default spacesRoutes;
