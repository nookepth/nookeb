-- 035_legacy_box_audio.sql
-- กล่องของขวัญ (Legacy Box) — optional voice message on a box.
--
-- One nullable column: the R2 key of the sender's recorded clip. NULL is a
-- valid, permanent state — every box created before this migration has no
-- voice message and nothing backfills them; the reveal page simply omits the
-- player. Same shape as the 034 columns: nullable, no default, additive.
--
-- The CHECK pins the key to the feature's own R2 prefix (rather than the file
-- model's `spaces/…`), so a bug elsewhere can never point a box's audio at a
-- LINE-uploaded file. Keys are built ONLY server-side by
-- buildLegacyBoxAudioKey() from the authenticated user id + the new box id —
-- the client never supplies or sees an R2 key, so there is no traversal or
-- cross-user-reference surface for this column to guard against.
--
-- NOT auto-applied — run in the Supabase SQL editor BEFORE deploying the code
-- (POST /legacy-box writes this column and errors without it). Additive, so the
-- currently-deployed code keeps working once applied but before the new code
-- ships: safe in either order.

ALTER TABLE legacy_boxes
  ADD COLUMN audio_key TEXT
    CHECK (audio_key IS NULL OR audio_key LIKE 'legacy-box/%');
