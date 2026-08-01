-- ---------------------------------------------------------------------------
-- 056 — §4b reminder intervals: add the two SHORT leads (5 นาที and 0 = ถึงกำหนดพอดี)
--
-- WHY. Migration 055 widened the picker to thirteen lead times but deliberately
-- floored the list at 15 minutes, on the reasoning that anything shorter is
-- usually already in the past when the task is created and leaves no time to
-- act. That is a UX caveat, not a functional constraint — the picker already
-- computes each row's real fire time and strikes past rows through with
-- "เลยเวลาแล้ว หนูจะข้ามรอบนี้", so a short lead that will not fire is visible
-- BEFORE the task is created. This migration adds the two the product asked
-- for, taking the menu to FIFTEEN:
--
--     5   =  ก่อนกำหนด 5 นาที
--     0   =  ถึงกำหนดพอดี  (fire AT the deadline)
--
-- `0` IS A LEAD TIME, NOT A SENTINEL. It is worth stating in the schema because
-- the RETIRED number-stepper UI used 0 on a DIFFERENT column
-- (`tasks.reminder_count`, migration 047) to mean "ไม่เตือน". That convention
-- never applied to this column and does not now: the ONLY "no reminders" state
-- for reminder_intervals is NULL or a selection that was never made. The CHECK
-- below still forbids an empty array (cardinality >= 1), so a row can never
-- express "selected nothing" as `{}` either — absence is NULL, and 0 is a time.
--
-- APPLY BEFORE THE API/WORKER DEPLOY, same as 055: a redeployed client can POST
-- a 5 or a 0 and the old CHECK would reject the whole create. The reverse order
-- is safe — an un-redeployed API simply never produces these values.
--
-- SAFE TO RE-RUN: both statements are DROP IF EXISTS + ADD.
--
-- NOT A UNIT CHANGE. Unlike 055 this migration rewrites NO data: it only widens
-- two CHECK constraints. Every existing tasks row and every existing
-- task_reminders row stays valid untouched.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Widen tasks.reminder_intervals
--
-- DISJOINTNESS STILL HOLDS, which is what keeps `normalizeLeadMinutes`
-- (packages/shared) and 055's in-place hour→minute backfill unambiguous:
--
--     legacy HOUR values   {3, 6, 24, 48, 72}
--     new minute values    {5, 0}
--
-- No overlap, so a stored 5 or 0 can only ever be minutes — neither is a legacy
-- hour choice, and neither equals any other member of the minute set (including
-- each other and the -60 overdue chase). plans.test.ts asserts this for the
-- whole list rather than for these two values specifically.
--
-- cardinality stays 1..4. The MENU widened; the ENTITLEMENT did not — the
-- ceiling is REMINDER_POLICY.premium.maxSelectable (apps/api/src/config/plans.ts),
-- not the length of the choice list.
-- ---------------------------------------------------------------------------

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_reminder_intervals_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_reminder_intervals_check CHECK (
    reminder_intervals IS NULL OR (
      -- Keep in lockstep with REMINDER_INTERVAL_CHOICES (config/plans.ts) and
      -- REMIND_SHOTS (packages/shared); plans.test.ts asserts they agree.
      -- 0 = fire at the deadline; -60 is the one value after it.
      reminder_intervals <@ ARRAY[10080, 7200, 4320, 2880, 1440, 720, 360, 180, 120, 60, 30, 15, 5, 0, -60]
      -- cardinality(), not array_length(): array_length('{}', 1) is NULL, and a
      -- NULL comparison makes a CHECK PASS — an empty array would slip through.
      -- cardinality('{}') is 0, which fails the range as intended. This is also
      -- what keeps "no reminders" out of this column entirely, so 0 can never be
      -- confused for it.
      AND cardinality(reminder_intervals) BETWEEN 1 AND 4
      AND nookeb_int_array_is_distinct(reminder_intervals)
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Widen task_reminders.remind_type for the two new shot names
--
-- Purely additive — the thirteen names 055 left behind are unchanged, so every
-- existing reminder row stays valid and nothing is rewritten. Safe to apply
-- before or after the code deploy in either direction. Keep in lockstep with the
-- RemindType union derived from REMIND_SHOTS in packages/shared, or a scheduled
-- reminder fails its insert at midnight.
-- ---------------------------------------------------------------------------

ALTER TABLE task_reminders DROP CONSTRAINT IF EXISTS task_reminders_remind_type_check;
ALTER TABLE task_reminders
  ADD CONSTRAINT task_reminders_remind_type_check CHECK (
    remind_type IN (
      '1_week', '5_days', '3_days', '2_days', '1_day',
      '12_hours', '6_hours', '3_hours', '2_hours', '1_hour',
      '30_min', '15_min', '5_min',
      'at_deadline',
      'overdue'
    )
  );
