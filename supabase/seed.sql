-- Seed data สำหรับ local development
INSERT INTO users (id, line_user_id, display_name, plan)
VALUES ('00000000-0000-0000-0000-000000000001', 'U_dev_local_user', 'Dev User', 'free')
ON CONFLICT (line_user_id) DO NOTHING;

INSERT INTO spaces (id, name, owner_id, type)
VALUES ('00000000-0000-0000-0000-0000000000a1', 'My Space', '00000000-0000-0000-0000-000000000001', 'personal')
ON CONFLICT (id) DO NOTHING;

INSERT INTO space_members (space_id, user_id, role)
VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'owner')
ON CONFLICT DO NOTHING;
