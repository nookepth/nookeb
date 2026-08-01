/**
 * ระบบตามงาน — master switch for every task PUSH the product sends.
 *
 * ON by default since 2026-08-01. It used to be a hard-coded `false` while push
 * delivery was being proven out; it is now a DEFAULT-ON kill switch, so the
 * single place to turn task messaging off in an incident is
 * `TASK_NOTIFICATIONS_ENABLED=false` in the environment — no redeploy of a
 * constant, no code change.
 *
 * What the switch covers (everything; there is no longer an unguarded path):
 *
 *   - API: `scheduleReminders` creates no task_reminders rows and no BullMQ
 *     delayed jobs on create / edit / recurring rollover while off.
 *   - API: the group ANNOUNCEMENT on create (POST /tasks), the "ยกเลิกงาน"
 *     notice on cancel (DELETE /tasks/:id) AND the review-loop notices
 *     (submit / approve / reject — `notifyTaskChat` in routes/tasks.ts). The
 *     review loop was the hole this gate used to leave open: three push paths
 *     kept messaging groups while every other task push was disabled.
 *   - Worker: `processTaskReminder` and the `task_notify` handler stand any
 *     in-flight job down without pushing (belt-and-braces for jobs queued
 *     before the flag flipped).
 *   - Web (LIFF): the copy that promises "หนูเก็บจะเตือนให้" is hidden so the UI
 *     never advertises a reminder it won't send.
 *
 * What it does NOT touch (deliberately): recurring rollover (recurrence keeps
 * advancing rounds either way) and existing task_reminders rows in the DB (left
 * dormant, never wiped).
 *
 * ENV READ, IN A PACKAGE THAT IS OTHERWISE ENV-FREE — deliberate, and the only
 * one here. The guard below matters: this module is bundled into the Next.js
 * CLIENT bundle by the LIFF pages, where `process` may not exist. An unset or
 * unrecognised value resolves to `true`, so the browser (which is never given
 * this variable) and any test importing the package without an .env both see
 * the default. Only the exact string "false" turns it off.
 */
function readTaskNotificationsFlag(): boolean {
  try {
    if (typeof process === 'undefined' || !process.env) return true;
    return process.env.TASK_NOTIFICATIONS_ENABLED !== 'false';
  } catch {
    return true;
  }
}

export const TASK_NOTIFICATIONS_ENABLED = readTaskNotificationsFlag();
