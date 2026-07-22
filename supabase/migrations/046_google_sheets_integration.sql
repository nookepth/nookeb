-- 046: Google Sheets sync — ต่อบัญชี Google ของผู้ใช้ แล้ว sync งานลง Sheet ของเขาเอง.
--
-- NOT auto-applied; apply BEFORE the API deploy (the /integrations routes and
-- the sheets-sync worker read/write this table). Additive — no existing table is
-- touched, so the currently-deployed code keeps working either way.
--
-- ประวัติที่ต้องไม่ทำซ้ำ: migration 002 เคยมี `google_accounts` ที่เก็บ refresh
-- token เป็น PLAINTEXT และถูก DROP ทิ้งใน 017 ด้วยเหตุผลนั้นโดยตรง (token ของ
-- third-party รั่วถาวรถ้า DB หลุด). รอบนี้ token ถูกเข้ารหัสด้วย AES-256-GCM
-- ผ่าน services/vault-crypto.ts (คีย์ derive จาก VAULT_MASTER_KEY + user id,
-- คนละ salt namespace กับคีย์ของไฟล์ในห้องนิรภัย) — คอลัมน์นี้จึงต้องไม่เคย
-- เก็บค่าดิบ ไม่ว่าจะเพื่อ debug ชั่วคราวก็ตาม.
CREATE TABLE google_integrations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- หนึ่งคน = หนึ่งการเชื่อมต่อ (UNIQUE): การเชื่อมใหม่ทับของเดิมเสมอ
  user_id           UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  -- base64(iv || tag || ciphertext) ของ refresh token — ห้ามเก็บ plaintext
  encrypted_token   TEXT NOT NULL,
  -- อีเมลบัญชี Google ที่เชื่อม (แสดงใน UI ให้รู้ว่าต่อกับบัญชีไหนอยู่)
  google_email      TEXT,
  sheet_id          TEXT,   -- Google Spreadsheet id
  sheet_url         TEXT,
  last_synced_at    TIMESTAMPTZ,
  -- ข้อความ error ล่าสุดจากการ sync (เช่น token ถูก revoke) — UI ใช้บอกผู้ใช้ว่า
  -- ต้องเชื่อมใหม่ แทนที่จะเงียบแล้วปล่อยให้ Sheet ค้างเก่าอยู่เฉยๆ
  last_error        TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- RLS backstop — เหมือน 036/037/045: API/worker ใช้ service role (bypass RLS)
-- และเช็คสิทธิ์ระดับ route เอง. เปิด RLS โดยไม่มี policy = deny-all ทุกทางอื่น.
-- สำคัญเป็นพิเศษกับตารางนี้ เพราะมันถือ credential ของ third-party.
ALTER TABLE google_integrations ENABLE ROW LEVEL SECURITY;

-- ลิงก์งาน → แถวใน Sheet. เก็บฝั่งเราไม่ได้พึ่ง Sheet เพราะผู้ใช้แก้/ลบแถวเองได้
-- ทุกเมื่อ; แต่ "รหัสงาน" ที่เขียนลงคอลัมน์สุดท้าย (ซ่อนไว้) คือ source of truth
-- ตอน sync — ตารางนี้ไม่ต้องมี. เก็บแค่ลำดับล่าสุดไว้กันการ re-append ซ้ำ.
CREATE INDEX idx_google_integrations_user ON google_integrations(user_id);
