-- 049: group_members gets a tombstone column so LINE `memberLeft` removal is
-- actually enforceable, not cosmetic.
--
-- Background: `ensureGroupMember` (task.service.ts) treats mere possession of a
-- shape-valid group id as proof of membership and silently re-creates a missing
-- roster row. A HARD DELETE on memberLeft (the original shape of this fix) is
-- therefore undone on the caller's very next authenticated request to any
-- group-scoped route (POST /tasks, GET /groups/:id/members, POST /groups/:id/
-- register, GET /spaces/:id/tasks) — the ex-member still knows the group id, so
-- they simply get re-enrolled. That makes the removal handler a no-op against
-- anyone who actually held access before being removed.
--
-- Fix: removal becomes a soft tombstone (removed_at). Only a LINE-OBSERVED
-- signal is allowed to clear it — a message/postback/unsend/memberJoined event
-- in the group, or a fresh members/ids roster sync, all handled by the existing
-- upsertGroupMember() write path, which now always clears removed_at. The
-- capability-only path (ensureGroupMember, reached from client-authenticated
-- routes with no proof LINE currently considers the caller a group member) may
-- still auto-enroll a caller with NO EXISTING row (first-time open, unchanged
-- UX), but must NOT resurrect a row it knows was explicitly tombstoned.
--
-- ADDITIVE + either-order-safe: NULL column, existing rows unaffected
-- (removed_at defaults NULL = active, same as before this migration existed).
ALTER TABLE group_members
  ADD COLUMN removed_at TIMESTAMPTZ;

-- Roster reads (GET /groups/:id/members, the assignee picker, ห้องทีม) filter
-- on removed_at IS NULL — index it alongside the existing group_line_id index.
CREATE INDEX IF NOT EXISTS idx_group_members_active
  ON group_members(group_line_id) WHERE removed_at IS NULL;
