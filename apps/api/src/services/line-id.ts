/**
 * LINE chat-id shape guard — the SERVER-SIDE trust boundary for anything that
 * ends up in `tasks.group_line_id` / `group_members.group_line_id`.
 *
 * Messaging-API chat ids are `C` + 32 lowercase hex (group) or `R` + 32 (room).
 * A LINE USER id is `U` + 32 hex and must NEVER be accepted where a group id is
 * expected: `ensureGroupMember` treats "holds the id" as proof of membership,
 * which is only safe for group/room ids, and a task stored under a U... id would
 * push Flex cards straight into that person's private 1-on-1 chat with the OA
 * (migration 043 documents this exact risk).
 *
 * The DB CHECK added by migration 043 (`tasks_scope_exclusive`) only asserts
 * NULL-ness per mode — it cannot see the id's shape. THIS regex, applied at
 * every route that accepts a client-supplied group id, is the real guard.
 * `apps/web/lib/liff.ts` has the same pattern client-side; that copy is a UX
 * filter only and carries no security weight.
 */
export const LINE_CHAT_ID_RE = /^[CR][0-9a-f]{32}$/;

/** Message used by every zod validator below, so the 400s read the same. */
export const LINE_CHAT_ID_MESSAGE = 'groupId must be a valid LINE group or room ID';
