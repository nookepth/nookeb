import type { FastifyPluginAsync } from 'fastify';
import type { SpaceRecord, SpaceRole } from '@nookeb/shared';

function categoryOf(mime: string): string {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'other';
}

const analyticsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  // GET /me/usage — storage usage + breakdown for the analytics dashboard
  app.get('/me/usage', async (request, reply) => {
    const userId = request.authUser!.userId;

    const { data: user, error: userErr } = await app.supabase
      .from('users')
      .select('storage_used, storage_limit')
      .eq('id', userId)
      .maybeSingle();
    if (userErr) throw userErr;
    if (!user) return reply.code(404).send({ error: 'User not found' });

    // Files this user uploaded (drives their personal quota) — breakdown by type.
    // Aggregated per mime_type in SQL (a plain select is capped at 1000 rows by
    // PostgREST, which would undercount); the category mapping stays in JS.
    const { data: mimeRows, error: mfErr } = await app.supabase.rpc('usage_by_mime', {
      p_user_id: userId,
    });
    if (mfErr) throw mfErr;

    const byTypeMap = new Map<string, { count: number; bytes: number }>();
    let totalFileCount = 0;
    for (const row of (mimeRows as
      | { mime_type: string; file_count: number; total_bytes: number }[]
      | null) ?? []) {
      const fileCount = Number(row.file_count);
      const bytes = Number(row.total_bytes);
      const cat = categoryOf(row.mime_type);
      const cur = byTypeMap.get(cat) ?? { count: 0, bytes: 0 };
      cur.count += fileCount;
      cur.bytes += bytes;
      byTypeMap.set(cat, cur);
      totalFileCount += fileCount;
    }
    const byType = [...byTypeMap.entries()]
      .map(([type, v]) => ({ type, ...v }))
      .sort((a, b) => b.bytes - a.bytes);

    // Per-space totals across every space the user belongs to
    const { data: memberRows, error: memErr } = await app.supabase
      .from('space_members')
      .select('role, spaces!inner(*)')
      .eq('user_id', userId);
    if (memErr) throw memErr;
    const spacesInfo = (memberRows as unknown as { role: SpaceRole; spaces: SpaceRecord }[]) ?? [];
    const spaceIds = spacesInfo.map((s) => s.spaces.id);

    const totalsBySpace = new Map<string, { count: number; bytes: number }>();
    if (spaceIds.length > 0) {
      // Aggregated per space in SQL (avoids the 1000-row select cap).
      const { data: spaceStats, error: sfErr } = await app.supabase.rpc('usage_by_space', {
        p_space_ids: spaceIds,
      });
      if (sfErr) throw sfErr;
      for (const row of (spaceStats as
        | { space_id: string; file_count: number; total_bytes: number }[]
        | null) ?? []) {
        totalsBySpace.set(row.space_id, {
          count: Number(row.file_count),
          bytes: Number(row.total_bytes),
        });
      }
    }

    const spaces = spacesInfo.map(({ spaces: s, role }) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      role,
      fileCount: totalsBySpace.get(s.id)?.count ?? 0,
      bytes: totalsBySpace.get(s.id)?.bytes ?? 0,
    }));

    return {
      storageUsed: user.storage_used as number,
      storageLimit: user.storage_limit as number,
      fileCount: totalFileCount,
      byType,
      spaces,
    };
  });
};

export default analyticsRoutes;
