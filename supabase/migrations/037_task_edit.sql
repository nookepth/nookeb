-- 037: ระบบตามงาน editing — per-assignee "done note", task-level attached links,
-- and the columns that back task cancel/edit (cancel reuses tasks.deleted_at +
-- status='cancelled' from 036, so no new column is needed there).
--
-- NOT auto-applied; apply BEFORE deploying the task-edit code:
--   * POST /tasks/:id/links + DELETE …/:linkId read/write task_links;
--   * POST …/items/:itemId/done and PATCH …/note write task_assignees.done_note.
--
-- IMPORTANT — wider blast radius than "additive": getTaskWithDetails() now also
-- SELECTs task_links, and it backs the EXISTING reads too (GET /tasks/:id,
-- GET /tasks/mine, the reminder worker). So if the new code deploys BEFORE this
-- migration, task_links is missing and EVERY task read throws — not just the new
-- link/note routes. Apply 037 first, then deploy. (The pre-037 code is unaffected
-- by this migration existing; only the new code hard-depends on it.)

-- Per-assignee note captured when someone marks their part done (replaces the
-- deferred "attach evidence" idea — a short text instead of a file). Editable
-- afterwards via PATCH …/note. NULL = no note.
ALTER TABLE task_assignees ADD COLUMN done_note TEXT;

-- TASK_LINKS — reference links attached to a task (task-level, not per-item):
-- a URL + optional label. Ordered by sort_order for stable display. Soft-delete
-- is unnecessary here (a link carries no quota/tombstone concern) — DELETE removes
-- the row outright, unlike tasks/items which are soft-deleted.
CREATE TABLE task_links (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id             UUID NOT NULL REFERENCES tasks(id),
  url                 TEXT NOT NULL,
  label               TEXT,
  sort_order          INT NOT NULL DEFAULT 0,
  created_by_line_uid TEXT NOT NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_task_links_task_id ON task_links(task_id);

-- RLS backstop — same rationale as 036: the API/worker use the SERVICE ROLE key
-- (bypasses RLS) and enforce group membership explicitly per route. Enabling RLS
-- with no policies makes every non-service-role path deny-all.
ALTER TABLE task_links ENABLE ROW LEVEL SECURITY;
