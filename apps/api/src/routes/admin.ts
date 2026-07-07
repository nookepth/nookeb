import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SpaceRecord, UserRecord } from '@nookeb/shared';
import { isAdminLineUser } from '../config';

const adminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);
  // Gate: only configured admin LINE user ids
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAdminLineUser(request.authUser!.lineUserId)) {
      await reply.code(403).send({ error: 'Admin access required' });
    }
  });

  // GET /admin/users — all users with storage + file counts
  app.get('/admin/users', async () => {
    const { data: users, error } = await app.supabase
      .from('users')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) throw error;

    // Count files per user in SQL (GROUP BY) — a plain select is capped at
    // 1000 rows by PostgREST, which would silently undercount.
    const { data: counts, error: fErr } = await app.supabase.rpc('admin_file_counts_by_user');
    if (fErr) throw fErr;
    const countByUser = new Map<string, number>();
    for (const row of (counts as { uploaded_by: string; file_count: number }[] | null) ?? []) {
      countByUser.set(row.uploaded_by, Number(row.file_count));
    }

    return {
      users: (users as UserRecord[]).map((u) => ({
        id: u.id,
        lineUserId: u.line_user_id,
        displayName: u.display_name,
        plan: u.plan,
        storageUsed: u.storage_used,
        storageLimit: u.storage_limit,
        fileCount: countByUser.get(u.id) ?? 0,
        createdAt: u.created_at,
        isAdmin: isAdminLineUser(u.line_user_id),
      })),
    };
  });

  // GET /admin/spaces — all spaces with member + file counts
  app.get('/admin/spaces', async () => {
    const { data: spaces, error } = await app.supabase
      .from('spaces')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) throw error;

    const { data: members, error: mErr } = await app.supabase
      .from('space_members')
      .select('space_id');
    if (mErr) throw mErr;
    const memberCount = new Map<string, number>();
    for (const m of members ?? []) {
      const k = m.space_id as string;
      memberCount.set(k, (memberCount.get(k) ?? 0) + 1);
    }

    // Count + sum file sizes per space in SQL (GROUP BY) — a plain select is
    // capped at 1000 rows by PostgREST, which would silently undercount.
    const { data: statRows, error: fErr } = await app.supabase.rpc('admin_file_stats_by_space');
    if (fErr) throw fErr;
    const fileStats = new Map<string, { count: number; bytes: number }>();
    for (const row of (statRows as
      | { space_id: string; file_count: number; total_bytes: number }[]
      | null) ?? []) {
      fileStats.set(row.space_id, {
        count: Number(row.file_count),
        bytes: Number(row.total_bytes),
      });
    }

    return {
      spaces: (spaces as SpaceRecord[]).map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        lineGroupId: s.line_group_id,
        memberCount: memberCount.get(s.id) ?? 0,
        fileCount: fileStats.get(s.id)?.count ?? 0,
        bytes: fileStats.get(s.id)?.bytes ?? 0,
        createdAt: s.created_at,
      })),
    };
  });

  // PATCH /admin/users/:id — adjust a user's storage quota.
  // This is the only place that may set storage_limit to an arbitrary value.
  // redeem_referral uses GREATEST() to avoid overwriting this.
  app.patch<{ Params: { id: string } }>('/admin/users/:id', async (request, reply) => {
    const parsed = z
      .object({ storageLimit: z.number().int().positive() })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }

    const { data, error } = await app.supabase
      .from('users')
      .update({ storage_limit: parsed.data.storageLimit, updated_at: new Date().toISOString() })
      .eq('id', request.params.id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) return reply.code(404).send({ error: 'User not found' });
    return { id: (data as UserRecord).id, storageLimit: (data as UserRecord).storage_limit };
  });
};

export default adminRoutes;
