-- ---------------------------------------------------------------------------
-- 055 — §4b reminder intervals: HOURS → MINUTES, and thirteen choices, not five
--
-- WHY. The picker only ever offered 3h / 6h / 1d / 2d / 3d, because
-- `tasks.reminder_intervals` is an INTEGER[] of HOURS and a 15-minute lead time
-- is not expressible in integer hours. This migration re-bases the column to
-- MINUTES and widens the allowed set to the thirteen the new picker offers,
-- including the first NEGATIVE value: -60 = 60 minutes AFTER the deadline (the
-- `overdue` chase, previously reachable only through the "เตือน N ครั้ง" chat
-- command and never selectable in a form).
--
-- APPLY BEFORE THE API/WORKER DEPLOY. The API validates a POSTed selection
-- against the minute set, so a new client against an un-migrated DB would have
-- every create rejected by the old CHECK. The reverse order is safe: the code
-- reads pre-055 rows through `normalizeLeadMinutes` (packages/shared), so an
-- API deployed first keeps scheduling the right shots from un-converted rows.
--
-- SAFE TO RE-RUN. See the disjointness argument on step 1.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Backfill hours → minutes
--
-- IDEMPOTENT BY DISJOINTNESS, which is the whole reason this conversion can be
-- done in place rather than behind a new column:
--
--     legacy hour choices  {3, 6, 24, 48, 72}
--     × 60                 {180, 360, 1440, 2880, 4320}
--
-- The two sets share no member, so an array that still intersects the legacy
-- set can only be un-converted, and a converted array can never match the WHERE
-- clause again. Running this twice — or running it after the API has already
-- started writing minute values — changes nothing.
--
-- The `&&` (overlaps) guard also means a row written by a NEW client between
-- this statement and the CHECK swap below is left alone: minute values such as
-- 15 or 10080 do not overlap the legacy set.
--
-- Every element is converted, not just the overlapping ones, because before
-- this migration EVERY element of a non-null array came from the legacy set.
-- ---------------------------------------------------------------------------

UPDATE tasks
SET reminder_intervals = ARRAY(
      SELECT x * 60 FROM unnest(reminder_intervals) AS x
    )
WHERE reminder_intervals IS NOT NULL
  AND reminder_intervals && ARRAY[3, 6, 24, 48, 72];

-- ---------------------------------------------------------------------------
-- 2. Swap the CHECK to the minute set
--
-- ADD CONSTRAINT validates every existing row, which is exactly what we want
-- here — it is the proof that step 1 converted everything. If this fails, step 1
-- missed rows; do NOT add NOT VALID to force it through, investigate instead.
--
-- cardinality stays 1..4: the ceiling is the top plan's maxSelectable
-- (REMINDER_POLICY.premium in apps/api/src/config/plans.ts), not the length of
-- the choice list. Widening the menu does not widen the entitlement.
-- ---------------------------------------------------------------------------

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_reminder_intervals_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_reminder_intervals_check CHECK (
    reminder_intervals IS NULL OR (
      -- Keep in lockstep with REMINDER_INTERVAL_CHOICES (config/plans.ts) and
      -- REMIND_SHOTS (packages/shared); plans.test.ts asserts they agree.
      -- -60 is the one value after the deadline (the overdue chase).
      reminder_intervals <@ ARRAY[10080, 7200, 4320, 2880, 1440, 720, 360, 180, 120, 60, 30, 15, -60]
      -- cardinality(), not array_length(): array_length('{}', 1) is NULL, and a
      -- NULL comparison makes a CHECK PASS — an empty array would slip through.
      -- cardinality('{}') is 0, which fails the range as intended.
      AND cardinality(reminder_intervals) BETWEEN 1 AND 4
      AND nookeb_int_array_is_distinct(reminder_intervals)
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Widen task_reminders.remind_type for the seven new shots
--
-- The six names migration 051 left behind are UNCHANGED, so every existing
-- reminder row stays valid and no reminder row is rewritten by this migration —
-- only the numbers in `tasks.reminder_intervals` moved. Keep this list in
-- lockstep with the RemindType union derived from REMIND_SHOTS in
-- packages/shared/src/types/task.ts, or a scheduled reminder fails its insert
-- at midnight.
--
-- Purely additive, so this statement is safe to apply before or after the code
-- deploy in either direction.
-- ---------------------------------------------------------------------------

ALTER TABLE task_reminders DROP CONSTRAINT IF EXISTS task_reminders_remind_type_check;
ALTER TABLE task_reminders
  ADD CONSTRAINT task_reminders_remind_type_check CHECK (
    remind_type IN (
      '1_week', '5_days', '3_days', '2_days', '1_day',
      '12_hours', '6_hours', '3_hours', '2_hours', '1_hour',
      '30_min', '15_min',
      'overdue'
    )
  );
