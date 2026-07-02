import type { FastifyPluginAsync } from 'fastify';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import {
  toSpaceDto,
  type SpaceDto,
  type SpaceMemberDto,
  type SpaceRecord,
  type SpaceRole,
} from '@nookeb/shared';
import { config } from '../config';
import { addMember, getMemberRole } from '../services/space.service';

interface InviteTokenPayload {
  spaceId: string;
  kind: 'space_invite';
}

function signInviteToken(spaceId: string): string {
  return jwt.sign({ spaceId, kind: 'space_invite' }, config.JWT_SECRET, { expiresIn: '7d' });
}

function verifyInviteToken(token: string): string | null {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as InviteTokenPayload;
    return decoded.kind === 'space_invite' && decoded.spaceId ? decoded.spaceId : null;
  } catch {
    return null;
  }
}

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

  // POST /spaces — create a team space (creator becomes owner)
  app.post('/spaces', async (request, reply) => {
    const parsed = z.object({ name: z.string().min(1).max(120) }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }
    const userId = request.authUser!.userId;

    const { data: space, error } = await app.supabase
      .from('spaces')
      .insert({ name: parsed.data.name, owner_id: userId, type: 'team' })
      .select('*')
      .single();
    if (error) throw error;
    await addMember(app.supabase, (space as SpaceRecord).id, userId, 'owner');
    return reply.code(201).send(toSpaceDto(space as SpaceRecord, 'owner'));
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

  // POST /spaces/:id/invites — owner/admin mints a 7-day invite link
  app.post<{ Params: { id: string } }>('/spaces/:id/invites', async (request, reply) => {
    const userId = request.authUser!.userId;
    const role = await getMemberRole(app.supabase, request.params.id, userId);
    if (!role) return reply.code(403).send({ error: 'Not a member of this space' });
    if (role !== 'owner' && role !== 'admin') {
      return reply.code(403).send({ error: 'Only owner/admin can invite' });
    }

    const token = signInviteToken(request.params.id);
    return { token, url: `${config.WEB_URL}/join?token=${encodeURIComponent(token)}`, expiresInDays: 7 };
  });

  // POST /spaces/join — accept an invite token
  app.post('/spaces/join', async (request, reply) => {
    const parsed = z.object({ token: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }
    const spaceId = verifyInviteToken(parsed.data.token);
    if (!spaceId) return reply.code(400).send({ error: 'Invite link is invalid or expired' });

    const { data: space, error } = await app.supabase
      .from('spaces')
      .select('*')
      .eq('id', spaceId)
      .maybeSingle();
    if (error) throw error;
    if (!space) return reply.code(404).send({ error: 'Space no longer exists' });

    const userId = request.authUser!.userId;
    await addMember(app.supabase, spaceId, userId, 'member');
    const role = (await getMemberRole(app.supabase, spaceId, userId)) ?? 'member';
    return toSpaceDto(space as SpaceRecord, role);
  });
};

export default spacesRoutes;
