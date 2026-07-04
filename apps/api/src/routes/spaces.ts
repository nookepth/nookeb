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

  // GET /spaces — every space the user belongs to, with their role.
  // Team spaces are enriched with the linked team's name (spaces.line_group_id
  // → team_line_groups → teams) so the dashboard switcher can show the real
  // team name instead of the generic group-space name.
  app.get('/spaces', async (request) => {
    const userId = request.authUser!.userId;
    const { data, error } = await app.supabase
      .from('space_members')
      .select('role, spaces!inner(*)')
      .eq('user_id', userId);
    if (error) throw error;

    const rows = data as unknown as { role: SpaceRole; spaces: SpaceRecord }[];

    // Resolve team names for team spaces that are bound to a LINE group.
    const lineGroupIds = Array.from(
      new Set(
        rows
          .map((r) => r.spaces.line_group_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    );
    const teamNameByGroup = new Map<string, string>();
    if (lineGroupIds.length > 0) {
      const { data: bindings, error: bindErr } = await app.supabase
        .from('team_line_groups')
        .select('line_group_id, teams!inner(name, deleted_at)')
        .in('line_group_id', lineGroupIds)
        .is('teams.deleted_at', null);
      if (bindErr) throw bindErr;
      for (const b of bindings as unknown as {
        line_group_id: string;
        teams: { name: string };
      }[]) {
        teamNameByGroup.set(b.line_group_id, b.teams.name);
      }
    }

    const spaces: SpaceDto[] = rows.map((row) => {
      const teamName = row.spaces.line_group_id
        ? teamNameByGroup.get(row.spaces.line_group_id) ?? null
        : null;
      return toSpaceDto(row.spaces, row.role, teamName);
    });
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
