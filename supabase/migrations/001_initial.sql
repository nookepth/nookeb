-- หนูเก็บ (nookeb) — initial schema
-- Schema from Technical Specification v1.0 Part 2

-- USERS
-- เก็บข้อมูล user ที่ register ผ่าน LINE Login
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  line_user_id  TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  picture_url   TEXT,
  email         TEXT,
  plan          TEXT DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'team')),
  storage_used  BIGINT DEFAULT 0,          -- bytes
  storage_limit BIGINT DEFAULT 1073741824, -- 1 GB free tier
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- SPACES
-- workspace หนึ่งคนหรือหนึ่งทีม เป็น multi-tenant boundary
CREATE TABLE spaces (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  owner_id      UUID REFERENCES users(id),
  type          TEXT DEFAULT 'personal' CHECK (type IN ('personal', 'team')),
  line_group_id TEXT,                      -- ถ้า space มาจาก LINE Group
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- SPACE_MEMBERS
-- user ที่มีสิทธิ์เข้า space นั้น
CREATE TABLE space_members (
  space_id  UUID REFERENCES spaces(id) ON DELETE CASCADE,
  user_id   UUID REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (space_id, user_id)
);

-- FOLDERS
-- โครงสร้าง folder แบบ nested (self-referential)
CREATE TABLE folders (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id   UUID REFERENCES spaces(id) ON DELETE CASCADE,
  parent_id  UUID REFERENCES folders(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- FILES
-- ตารางหลัก ทุก file ที่เก็บใน system
CREATE TABLE files (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id        UUID REFERENCES spaces(id) ON DELETE CASCADE,
  folder_id       UUID REFERENCES folders(id) ON DELETE SET NULL,
  uploaded_by     UUID REFERENCES users(id),

  -- ชื่อและประเภท
  original_name   TEXT NOT NULL,
  display_name    TEXT,                 -- user rename ได้
  mime_type       TEXT NOT NULL,
  file_size       BIGINT NOT NULL,      -- bytes
  extension       TEXT,

  -- Storage
  r2_key          TEXT NOT NULL UNIQUE, -- path ใน R2 bucket
  r2_bucket       TEXT NOT NULL DEFAULT 'nookeb-files',
  thumbnail_key   TEXT,                 -- thumbnail สำหรับรูป/PDF

  -- LINE source
  line_message_id TEXT,                 -- LINE message ID ต้นทาง
  line_source     TEXT,                 -- 'user', 'group', 'room'
  line_group_id   TEXT,                 -- ถ้ามาจาก group

  -- Processing
  status          TEXT DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'ready', 'error')),
  ocr_text        TEXT,                 -- extracted text (future)

  -- Metadata
  captured_at     TIMESTAMPTZ,          -- เวลาจริงที่ถ่ายรูป/สร้างเอกสาร
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ           -- soft delete
);

-- TAGS
CREATE TABLE tags (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID REFERENCES spaces(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  color    TEXT DEFAULT '#6366f1',
  UNIQUE (space_id, name)
);

-- FILE_TAGS (many-to-many)
CREATE TABLE file_tags (
  file_id UUID REFERENCES files(id) ON DELETE CASCADE,
  tag_id  UUID REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (file_id, tag_id)
);

-- SCAN_SESSIONS
-- เก็บ session สำหรับ scan หลายหน้า แล้ว merge เป็น PDF
CREATE TABLE scan_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID REFERENCES users(id),
  space_id       UUID REFERENCES spaces(id),
  status         TEXT DEFAULT 'collecting'
                 CHECK (status IN ('collecting', 'processing', 'done', 'cancelled')),
  page_count     INT DEFAULT 0,
  result_file_id UUID REFERENCES files(id),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  expires_at     TIMESTAMPTZ DEFAULT NOW() + INTERVAL '2 hours'
);

-- SCAN_PAGES
-- แต่ละหน้าในการ scan
CREATE TABLE scan_pages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID REFERENCES scan_sessions(id) ON DELETE CASCADE,
  page_number     INT NOT NULL,
  r2_key          TEXT NOT NULL,
  line_message_id TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes สำหรับ performance
CREATE INDEX idx_files_space_id ON files(space_id);
CREATE INDEX idx_files_folder_id ON files(folder_id);
CREATE INDEX idx_files_status ON files(status);
CREATE INDEX idx_files_deleted_at ON files(deleted_at);
CREATE INDEX idx_files_created_at ON files(created_at DESC);
CREATE INDEX idx_files_ocr_text ON files USING gin(to_tsvector('simple', ocr_text))
  WHERE ocr_text IS NOT NULL;

-- Row Level Security (multi-tenant)
ALTER TABLE files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_see_own_space_files" ON files
  FOR ALL USING (
    space_id IN (
      SELECT space_id FROM space_members WHERE user_id = auth.uid()
    )
  );
