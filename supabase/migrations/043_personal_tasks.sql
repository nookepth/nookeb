-- 043: Personal Task — งานส่วนตัวที่สร้างใน 1-on-1 DM.
--
-- NOT auto-applied; apply BEFORE the API deploy (POST /tasks writes the new
-- columns and the personal branch reads them).
--
-- ทำไมต้อง DROP NOT NULL บน group_line_id: tenant key ของ personal task คือ
-- owner_line_uid ที่มาจาก session LINE Login ที่ verify แล้วเท่านั้น ห้ามยัด
-- U... (user id) ลง group_line_id เด็ดขาด เพราะ ensureGroupMember ใช้โมเดล
-- "ถือ id = เป็นสมาชิก" ซึ่งปลอดภัยเฉพาะกับ group id ที่เดาไม่ได้ ส่วน user id
-- รั่วผ่าน task_assignees / GET /groups/:id/members ให้เพื่อนร่วมกลุ่มเห็นได้
-- → เก็บเป็น NULL แทน แล้วให้ CHECK ข้างล่างบังคับว่าเป็นได้แค่โหมดเดียว
ALTER TABLE tasks ALTER COLUMN group_line_id DROP NOT NULL;

ALTER TABLE tasks ADD COLUMN is_personal    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN owner_line_uid TEXT;

-- โหมดเดียวเท่านั้น: group task ต้องมี group_line_id และห้ามมี owner;
-- personal task ต้องมี owner และ group_line_id ต้องเป็น NULL.
-- แถวเดิมทุกแถว (is_personal=false, group_line_id NOT NULL, owner NULL) ผ่านหมด.
ALTER TABLE tasks ADD CONSTRAINT tasks_scope_exclusive CHECK (
  (is_personal = false AND group_line_id IS NOT NULL AND owner_line_uid IS NULL)
  OR
  (is_personal = true  AND group_line_id IS NULL     AND owner_line_uid IS NOT NULL)
);

CREATE INDEX idx_tasks_owner_line_uid
  ON tasks(owner_line_uid) WHERE is_personal = true AND deleted_at IS NULL;
