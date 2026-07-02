import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { toTagDto, type TagRecord } from '@nookeb/shared';
import { isSpaceMember } from '../services/file.service';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const tagsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  // GET /tags?spaceId= — all tags in a space
  app.get('/tags', async (request, reply) => {
    const parsed = z.object({ spaceId: z.string().uuid() }).safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
    }
    const { spaceId } = parsed.data;

    if (!(await isSpaceMember(app.supabase, spaceId, request.authUser!.userId))) {
      return reply.code(403).send({ error: 'Not a member of this space' });
    }

    const { data, error } = await app.supabase
      .from('tags')
      .select('*')
      .eq('space_id', spaceId)
      .order('name', { ascending: true });
    if (error) throw error;

    return { tags: (data as TagRecord[]).map(toTagDto) };
  });

  // POST /tags — create tag
  app.post('/tags', async (request, reply) => {
    const bodySchema = z.object({
      spaceId: z.string().uuid(),
      name: z.string().min(1).max(60),
      color: z.string().regex(HEX_COLOR).optional(),
    });
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }
    const { spaceId, name, color } = parsed.data;

    if (!(await isSpaceMember(app.supabase, spaceId, request.authUser!.userId))) {
      return reply.code(403).send({ error: 'Not a member of this space' });
    }

    const { data, error } = await app.supabase
      .from('tags')
      .insert({ space_id: spaceId, name, ...(color ? { color } : {}) })
      .select('*')
      .single();
    if (error) {
      // UNIQUE (space_id, name)
      if (error.code === '23505') {
        return reply.code(409).send({ error: 'Tag name already exists in this space' });
      }
      throw error;
    }

    return reply.code(201).send(toTagDto(data as TagRecord));
  });

  async function getAuthorizedTag(tagId: string, userId: string): Promise<TagRecord | null> {
    const { data, error } = await app.supabase.from('tags').select('*').eq('id', tagId).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const tag = data as TagRecord;
    if (!(await isSpaceMember(app.supabase, tag.space_id, userId))) return null;
    return tag;
  }

  // PATCH /tags/:id — rename / recolor
  app.patch<{ Params: { id: string } }>('/tags/:id', async (request, reply) => {
    const bodySchema = z.object({
      name: z.string().min(1).max(60).optional(),
      color: z.string().regex(HEX_COLOR).optional(),
    });
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }

    const tag = await getAuthorizedTag(request.params.id, request.authUser!.userId);
    if (!tag) return reply.code(404).send({ error: 'Tag not found' });

    const updates: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) updates['name'] = parsed.data.name;
    if (parsed.data.color !== undefined) updates['color'] = parsed.data.color;

    const { data, error } = await app.supabase
      .from('tags')
      .update(updates)
      .eq('id', tag.id)
      .select('*')
      .single();
    if (error) throw error;
    return toTagDto(data as TagRecord);
  });

  // DELETE /tags/:id — file_tags rows cascade
  app.delete<{ Params: { id: string } }>('/tags/:id', async (request, reply) => {
    const tag = await getAuthorizedTag(request.params.id, request.authUser!.userId);
    if (!tag) return reply.code(404).send({ error: 'Tag not found' });

    const { error } = await app.supabase.from('tags').delete().eq('id', tag.id);
    if (error) throw error;
    return reply.code(204).send();
  });
};

export default tagsRoutes;
