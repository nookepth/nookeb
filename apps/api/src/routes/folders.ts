import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { toFolderDto, type FolderRecord } from '@nookeb/shared';
import { isSpaceMember } from '../services/file.service';

const foldersRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  // GET /folders?spaceId= — all folders in a space (client builds the tree)
  app.get('/folders', async (request, reply) => {
    const parsed = z.object({ spaceId: z.string().uuid() }).safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
    }
    const { spaceId } = parsed.data;

    if (!(await isSpaceMember(app.supabase, spaceId, request.authUser!.userId))) {
      return reply.code(403).send({ error: 'Not a member of this space' });
    }

    const { data, error } = await app.supabase
      .from('folders')
      .select('*')
      .eq('space_id', spaceId)
      .order('name', { ascending: true });
    if (error) throw error;

    return { folders: (data as FolderRecord[]).map(toFolderDto) };
  });

  // POST /folders — create folder
  app.post('/folders', async (request, reply) => {
    const bodySchema = z.object({
      spaceId: z.string().uuid(),
      name: z.string().min(1).max(120),
      parentId: z.string().uuid().nullable().optional(),
    });
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }
    const { spaceId, name, parentId } = parsed.data;
    const userId = request.authUser!.userId;

    if (!(await isSpaceMember(app.supabase, spaceId, userId))) {
      return reply.code(403).send({ error: 'Not a member of this space' });
    }

    if (parentId) {
      const { data: parent, error: parentErr } = await app.supabase
        .from('folders')
        .select('id')
        .eq('id', parentId)
        .eq('space_id', spaceId)
        .maybeSingle();
      if (parentErr) throw parentErr;
      if (!parent) return reply.code(400).send({ error: 'Parent folder not found in this space' });
    }

    const { data, error } = await app.supabase
      .from('folders')
      .insert({ space_id: spaceId, name, parent_id: parentId ?? null, created_by: userId })
      .select('*')
      .single();
    if (error) throw error;

    return reply.code(201).send(toFolderDto(data as FolderRecord));
  });

  // Loads a folder and enforces space membership
  async function getAuthorizedFolder(folderId: string, userId: string): Promise<FolderRecord | null> {
    const { data, error } = await app.supabase
      .from('folders')
      .select('*')
      .eq('id', folderId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const folder = data as FolderRecord;
    if (!(await isSpaceMember(app.supabase, folder.space_id, userId))) return null;
    return folder;
  }

  // PATCH /folders/:id — rename / move
  app.patch<{ Params: { id: string } }>('/folders/:id', async (request, reply) => {
    const bodySchema = z.object({
      name: z.string().min(1).max(120).optional(),
      parentId: z.string().uuid().nullable().optional(),
    });
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }

    const folder = await getAuthorizedFolder(request.params.id, request.authUser!.userId);
    if (!folder) return reply.code(404).send({ error: 'Folder not found' });

    if (parsed.data.parentId === folder.id) {
      return reply.code(400).send({ error: 'Folder cannot be its own parent' });
    }

    const updates: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) updates['name'] = parsed.data.name;
    if (parsed.data.parentId !== undefined) updates['parent_id'] = parsed.data.parentId;

    const { data, error } = await app.supabase
      .from('folders')
      .update(updates)
      .eq('id', folder.id)
      .select('*')
      .single();
    if (error) throw error;
    return toFolderDto(data as FolderRecord);
  });

  // DELETE /folders/:id — child folders cascade, files inside get folder_id = NULL
  app.delete<{ Params: { id: string } }>('/folders/:id', async (request, reply) => {
    const folder = await getAuthorizedFolder(request.params.id, request.authUser!.userId);
    if (!folder) return reply.code(404).send({ error: 'Folder not found' });

    const { error } = await app.supabase.from('folders').delete().eq('id', folder.id);
    if (error) throw error;
    return reply.code(204).send();
  });
};

export default foldersRoutes;
