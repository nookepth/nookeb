-- 045: ระบบตามงาน — แนบไฟล์กับงาน + วงจร "ส่งงานกลับ / รับงาน / ตีกลับ".
--
-- NOT auto-applied; apply BEFORE the API deploy. Blast radius is WIDER than
-- "additive": getTaskWithDetails() now also SELECTs task_files, and it backs
-- EVERY task read (GET /tasks/:id, GET /tasks/mine, the reminder worker). If the
-- new code deploys first, task_files is missing and every task read throws.
-- Apply 045 first, then deploy. (The currently-deployed code is unaffected by
-- this migration existing — it never reads the new table/columns.)
--
-- ทำไมเป็น junction table ไม่ใช่ files.task_id: ไฟล์ใบเดียวควรผูกได้หลายงาน
-- (แนบไฟล์เดิมซ้ำในงานถัดไป) และ `files` เป็นตารางร้อนที่ทุก flow อ่าน —
-- ไม่ควรบวมด้วยคอลัมน์ที่มีค่าเฉพาะงานตามงาน.

-- TASK_FILES — ไฟล์ที่แนบกับงาน. ตัวไฟล์จริงยังอยู่ใน `files` ตามปกติ (มี
-- space_id / quota ledger / soft-delete ครบ) แถวนี้เป็นแค่การผูกงาน↔ไฟล์.
-- ไม่มี soft-delete: การถอดไฟล์ออกจากงานคือการลบแถวผูกทิ้ง แล้ว soft-delete
-- แถวใน `files` แทน (ตรงกับ task_links ที่ลบแถวตรงๆ ได้เพราะไม่ถือ quota /
-- ไม่ต้องการ tombstone) — rule 6 ยังอยู่ครบที่ `files`.
CREATE TABLE task_files (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id              UUID NOT NULL REFERENCES tasks(id),
  -- ผูกกับ "ข้อ" ได้ (ไฟล์ที่ส่งกลับมาพร้อมข้อนั้น); NULL = ไฟล์ระดับงาน
  -- (แนบตอนสร้างงาน). ON DELETE ไม่ต้องมี — task_items ถูก soft-delete เท่านั้น.
  task_item_id         UUID REFERENCES task_items(id),
  file_id              UUID NOT NULL REFERENCES files(id),
  uploaded_by_line_uid TEXT NOT NULL,
  -- 'brief'  = ไฟล์ประกอบโจทย์ที่คนสั่งแนบตอนสร้าง/ระหว่างทาง
  -- 'submission' = ไฟล์ที่ผู้รับผิดชอบส่งกลับมา
  kind                 TEXT NOT NULL DEFAULT 'brief'
                       CHECK (kind IN ('brief', 'submission')),
  note                 TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (task_id, file_id)
);

CREATE INDEX idx_task_files_task_id ON task_files(task_id);
CREATE INDEX idx_task_files_file_id ON task_files(file_id);

-- RLS backstop — เหมือน 036/037: API/worker ใช้ service role (bypass RLS) และ
-- เช็คสิทธิ์ระดับ route เอง. เปิด RLS โดยไม่มี policy = deny-all ทุกทางอื่น.
ALTER TABLE task_files ENABLE ROW LEVEL SECURITY;

-- ---- สถานะใหม่ของ "ข้อ": submitted / rejected ----
-- เฉพาะ task_items เท่านั้น — `tasks.status` ไม่ถูกแตะ. งานทั้งใบยัง roll up
-- เป็น pending/in_progress/done/cancelled เหมือนเดิม; "รอตรวจ/ตีกลับ" เป็นสถานะ
-- ระดับข้อ เพราะเป็นเรื่องระหว่างผู้รับผิดชอบกับคนสั่งของข้อนั้น.
--
-- rollUpCompletion() ปลอดภัยกับสถานะใหม่โดยธรรมชาติ: ข้อที่ submitted ยังไม่มี
-- done_at ครบทุกคน → allDone=false และ status ไม่ใช่ 'done' → มันไม่แตะเลย.
ALTER TABLE task_items
  DROP CONSTRAINT IF EXISTS task_items_status_check;

ALTER TABLE task_items
  ADD CONSTRAINT task_items_status_check
    CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled', 'submitted', 'rejected'));

ALTER TABLE task_items ADD COLUMN IF NOT EXISTS submitted_at   TIMESTAMPTZ;
ALTER TABLE task_items ADD COLUMN IF NOT EXISTS rejected_at    TIMESTAMPTZ;
-- เหตุผลที่ตีกลับ (คนสั่งพิมพ์) — ถูกล้างเมื่อผู้รับผิดชอบส่งใหม่
ALTER TABLE task_items ADD COLUMN IF NOT EXISTS rejection_note TEXT;
-- หมายเหตุที่แนบมากับการส่งงานกลับ (แยกจาก task_assignees.done_note ซึ่งเป็น
-- ของรายคน — อันนี้เป็นของ "รอบการส่ง" ล่าสุดของข้อนั้น)
ALTER TABLE task_items ADD COLUMN IF NOT EXISTS submission_note TEXT;
