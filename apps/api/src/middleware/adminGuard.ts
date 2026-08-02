import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isAdminLineUser } from '../config';

/**
 * The /admin/* gate, in one place.
 *
 * Two preHandler hooks in a fixed order — authenticate FIRST, then the admin
 * check. The order is load-bearing, not stylistic: the gate reads
 * `request.authUser!.lineUserId`, which only exists after `app.authenticate`
 * has run. Reversing them would dereference undefined on every anonymous
 * request. Hooks registered on a Fastify instance run in registration order,
 * so this function is the whole contract.
 *
 * Extracted from routes/admin.ts so the second admin plugin (routes/admin-ops.ts)
 * cannot drift from the first. Admin membership has no DB column — it is the
 * ADMIN_LINE_USER_IDS env allowlist, read through `isAdminLineUser` (see
 * CLAUDE.md §13).
 *
 * MUST be called inside an ENCAPSULATED plugin scope (i.e. a plain
 * FastifyPluginAsync registered with `app.register(...)`, never one wrapped in
 * fastify-plugin). Fastify hooks added to a non-encapsulated scope leak to
 * every sibling route in that scope — here that would put an admin-only 403 in
 * front of the entire API. Both callers are plain plugins today.
 *
 * @param app the plugin's own encapsulated instance
 */
export function registerAdminGuard(app: FastifyInstance): void {
  app.addHook('preHandler', app.authenticate);
  // Gate: only configured admin LINE user ids
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAdminLineUser(request.authUser!.lineUserId)) {
      await reply.code(403).send({ error: 'Admin access required' });
    }
  });
}
