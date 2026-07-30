-- 047: ระบบตามงาน — per-task reminder-shot count (the Pro "เตือน N ครั้ง" knob on
-- the in-chat "หนูเก็บสั่งงาน" group command).
--
-- Adds ONE nullable column. NULL = the full default schedule (3 วัน / 1 วัน /
-- 3 ชม ก่อน + 1 ชม หลัง). A value 1..4 narrows it to that many shots, chosen by
-- selectRemindTypes() (task-command.ts). Only ever WRITTEN for Pro-created tasks;
-- every existing row and every LIFF/free task stays NULL.
--
-- ADDITIVE + either-order-safe: createTaskWithItems OMITS the column from the
-- insert unless a Pro custom count is set, so the currently-deployed code keeps
-- inserting valid rows before this is applied, and reads treat a missing column
-- as NULL/default. Apply it BEFORE a Pro user first uses "เตือน N ครั้ง".
ALTER TABLE tasks
  ADD COLUMN reminder_count INT
  CHECK (reminder_count IS NULL OR (reminder_count >= 1 AND reminder_count <= 4));
