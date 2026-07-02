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

    // Files this user uploaded (drives their personal quota) — breakdown by type
    const { data: myFiles, error: mfErr } = await app.supabase
      .from('files')
      .select('mime_type, file_size')
      .eq('uploaded_by', userId)
      .is('deleted_at', null);
    if (mfErr) throw mfErr;

    const byTypeMap = new Map<string, { count: number; bytes: number }>();
    for (const f of myFiles ?? []) {
      const cat = categoryOf(f.mime_type as string);
      const cur = byTypeMap.get(cat) ?? { count: 0, bytes: 0 };
      cur.count += 1;
      cur.bytes += f.file_size as number;
      byTypeMap.set(cat, cur);
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
      const { data: spaceFiles, error: sfErr } = await app.supabase
        .from('files')
        .select('space_id, file_size')
        .in('space_id', spaceIds)
        .is('deleted_at', null);
      if (sfErr) throw sfErr;
      for (const f of spaceFiles ?? []) {
        const cur = totalsBySpace.get(f.space_id as string) ?? { count: 0, bytes: 0 };
        cur.count += 1;
        cur.bytes += f.file_size as number;
        totalsBySpace.set(f.space_id as string, cur);
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
      fileCount: (myFiles ?? []).length,
      byType,
      spaces,
    };
  });
};

export default analyticsRoutes;
