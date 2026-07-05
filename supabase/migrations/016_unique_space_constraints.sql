-- 016_unique_space_constraints.sql — enforce one space per LINE group and one
-- personal space per user, closing the duplicate-space race.
-- NOT auto-applied — run via `supabase db push` or the Supabase SQL editor.
-- Apply BEFORE deploying the code that handles 23505 in ensureGroupSpace /
-- ensureUserAndSpace (the code is backward-compatible either way, but the race
-- is only actually closed once these indexes exist).
--
-- Root cause fixed: webhook events fan out concurrently, and ensureGroupSpace /
-- ensureUserAndSpace do find-then-insert with no DB constraint. Two concurrent
-- first-messages both insert → duplicate rows → every later maybeSingle()
-- lookup errors on "multiple rows" → group uploads permanently fail.
--
-- Step 1 deduplicates any rows the race already created (keep the OLDEST space,
-- merge everything that references the duplicates into it), so the unique
-- indexes in step 2 can be created safely. All statements are no-ops on a clean
-- database. Runs in one transaction — any failure rolls the whole thing back.

BEGIN;

------------------------------------------------------------------------------
-- Step 1a: duplicate GROUP spaces (same line_group_id) → merge into the oldest
------------------------------------------------------------------------------
CREATE TEMP TABLE dup_spaces ON COMMIT DROP AS
SELECT dup.id AS dup_id, canonical.id AS canonical_id
FROM (
  SELECT DISTINCT ON (line_group_id) id, line_group_id
  FROM spaces
  WHERE line_group_id IS NOT NULL
  ORDER BY line_group_id, created_at ASC, id ASC
) canonical
JOIN spaces dup
  ON dup.line_group_id = canonical.line_group_id
 AND dup.id <> canonical.id;

------------------------------------------------------------------------------
-- Step 1b: duplicate PERSONAL spaces (same owner) → merge into the oldest
------------------------------------------------------------------------------
INSERT INTO dup_spaces (dup_id, canonical_id)
SELECT dup.id, canonical.id
FROM (
  SELECT DISTINCT ON (owner_id) id, owner_id
  FROM spaces
  WHERE type = 'personal'
  ORDER BY owner_id, created_at ASC, id ASC
) canonical
JOIN spaces dup
  ON dup.owner_id = canonical.owner_id
 AND dup.type = 'personal'
 AND dup.id <> canonical.id;

-- Merge memberships (composite PK → conflict-safe), then drop the dup rows.
INSERT INTO space_members (space_id, user_id, role, joined_at)
SELECT d.canonical_id, sm.user_id, sm.role, sm.joined_at
FROM space_members sm
JOIN dup_spaces d ON sm.space_id = d.dup_id
ON CONFLICT (space_id, user_id) DO NOTHING;

DELETE FROM space_members sm USING dup_spaces d WHERE sm.space_id = d.dup_id;

-- Repoint content tables. (files.r2_key keeps its original path — the R2
-- object physically lives there, so the key must NOT be rewritten.)
UPDATE files f         SET space_id = d.canonical_id FROM dup_spaces d WHERE f.space_id = d.dup_id;
UPDATE folders fo      SET space_id = d.canonical_id FROM dup_spaces d WHERE fo.space_id = d.dup_id;
UPDATE scan_sessions s SET space_id = d.canonical_id FROM dup_spaces d WHERE s.space_id = d.dup_id;

-- Tags: move the ones whose name is free in the canonical space; for name
-- clashes, repoint file_tags to the canonical tag and let the dup tag cascade.
UPDATE tags t
   SET space_id = d.canonical_id
  FROM dup_spaces d
 WHERE t.space_id = d.dup_id
   AND NOT EXISTS (
     SELECT 1 FROM tags c WHERE c.space_id = d.canonical_id AND c.name = t.name
   );

INSERT INTO file_tags (file_id, tag_id)
SELECT ft.file_id, c.id
FROM file_tags ft
JOIN tags t       ON t.id = ft.tag_id
JOIN dup_spaces d ON t.space_id = d.dup_id
JOIN tags c       ON c.space_id = d.canonical_id AND c.name = t.name
ON CONFLICT (file_id, tag_id) DO NOTHING;

DELETE FROM tags t USING dup_spaces d WHERE t.space_id = d.dup_id; -- file_tags cascade

-- Alert tracking rows are regenerated on demand — just drop the dup ones.
DELETE FROM space_storage_alerts a USING dup_spaces d WHERE a.space_id = d.dup_id;

-- Finally remove the duplicate spaces themselves.
DELETE FROM spaces s USING dup_spaces d WHERE s.id = d.dup_id;

------------------------------------------------------------------------------
-- Step 2: unique indexes so the race can never recreate duplicates.
------------------------------------------------------------------------------
-- One space per LINE group.
CREATE UNIQUE INDEX IF NOT EXISTS uq_spaces_line_group_id
  ON spaces(line_group_id)
  WHERE line_group_id IS NOT NULL;

-- One personal space per owner. Scoped by type = 'personal' (NOT by
-- line_group_id/team_id being NULL — legacy unbound team-type spaces also have
-- both NULL and must not be constrained).
CREATE UNIQUE INDEX IF NOT EXISTS uq_spaces_personal_owner
  ON spaces(owner_id)
  WHERE type = 'personal';

COMMIT;
