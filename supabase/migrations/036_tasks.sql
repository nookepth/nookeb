-- 036: ระบบตามงาน (Task Manager) — LIFF-created group tasks + scheduled reminders.
-- NOT auto-applied; apply BEFORE deploying the task code (the /tasks and /groups
-- routes and the "/register" webhook command error without these tables;
-- everything else is unaffected). Additive only — touches no existing table.

-- TASKS — one chased job. group_line_id is the tenant key (tasks live in a LINE
-- group); space_id is a best-effort link to the group's shared space when one
-- exists (ensureGroupSpace) and is informational only — nothing about access
-- keys off it.
CREATE TABLE tasks (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id            UUID REFERENCES spaces(id),
  group_line_id       TEXT NOT NULL,
  title               TEXT NOT NULL,
  type                TEXT NOT NULL CHECK (type IN ('single', 'multi', 'recurring')),
  global_deadline     TIMESTAMPTZ,
  -- e.g. {"freq":"monthly","day":5,"time":"09:00"} (time is Asia/Bangkok)
  recurrence_rule     JSONB,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled')),
  created_by_line_uid TEXT NOT NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ  -- soft delete (rule: never hard DELETE)
);

-- TASK_ITEMS — every task has ≥1 item ('single'/'recurring' get one implicit
-- item so assignees/done-marking have a single shape; 'multi' has one per รายการ).
CREATE TABLE task_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID NOT NULL REFERENCES tasks(id),
  title       TEXT NOT NULL,
  description TEXT,
  deadline    TIMESTAMPTZ,  -- NULL = inherit tasks.global_deadline
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled')),
  sort_order  INT NOT NULL DEFAULT 0,
  deleted_at  TIMESTAMPTZ
);

-- TASK_ASSIGNEES — who owes each item. line_uid (not users.id): assignees are
-- picked from group_members, who may never have logged into the web app.
CREATE TABLE task_assignees (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_item_id UUID NOT NULL REFERENCES task_items(id),
  line_uid     TEXT NOT NULL,
  display_name TEXT,
  picture_url  TEXT,
  accepted_at  TIMESTAMPTZ,
  done_at      TIMESTAMPTZ,
  UNIQUE (task_item_id, line_uid)
);

-- TASK_REMINDERS — one row per scheduled reminder shot; the BullMQ delayed job
-- carries the row id and stamps sent_at / failed_at. cancelled_at marks
-- reminders withdrawn by done/cancel/reschedule (rows are never deleted).
CREATE TABLE task_reminders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      UUID REFERENCES tasks(id),
  task_item_id UUID REFERENCES task_items(id),
  remind_type  TEXT NOT NULL CHECK (remind_type IN ('3_days', '1_day', '3_hours', 'overdue')),
  remind_at    TIMESTAMPTZ NOT NULL,
  sent_at      TIMESTAMPTZ,
  failed_at    TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);

-- GROUP_MEMBERS — the LIFF assignee picker's roster. LINE's Messaging API can't
-- list group members, so users opt in once by typing "/register" (or "สมัคร")
-- in the group; upsert on re-register refreshes name/avatar.
CREATE TABLE group_members (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_line_id TEXT NOT NULL,
  line_uid      TEXT NOT NULL,
  display_name  TEXT,
  picture_url   TEXT,
  registered_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (group_line_id, line_uid)
);

CREATE INDEX idx_tasks_group_line_id ON tasks(group_line_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_task_items_task_id ON task_items(task_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_task_assignees_item_id ON task_assignees(task_item_id);
CREATE INDEX idx_task_assignees_line_uid ON task_assignees(line_uid);
CREATE INDEX idx_task_reminders_task_id ON task_reminders(task_id);
CREATE INDEX idx_group_members_group ON group_members(group_line_id);

-- RLS backstop. The API/worker use the SERVICE ROLE key (bypasses RLS) and
-- enforce group membership explicitly per route (caller's line_uid must be in
-- group_members for the task's group — see routes/tasks.ts). This app never
-- issues Supabase Auth sessions, so auth.uid() can't map to a tenant here:
-- enabling RLS with no policies makes every non-service-role path deny-all,
-- which is the correct backstop (same spirit as rule 4).
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_assignees ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;
