/**
 * ระบบตามงาน — master switch for the scheduled reminder-PUSH feature.
 *
 * TEMPORARY SOFT-DISABLE: push delivery isn't reliable yet, so the scheduled
 * "อย่าลืมงาน" reminders (3 วัน / 1 วัน / 3 ชม ก่อน + 1 ชม หลัง deadline) are
 * turned off across the whole app from this ONE constant. When push is ready,
 * flip this back to `true` and everything re-enables with NO other code change:
 *
 *   - API: `scheduleReminders` becomes a no-op, so no task_reminders rows or
 *     BullMQ delayed jobs are created on create / edit / recurring rollover.
 *   - Worker: `processTaskReminder` stands any in-flight reminder job down
 *     without pushing (belt-and-braces for jobs queued before the flag flipped).
 *   - Web (LIFF): the copy that promises "หนูเก็บจะเตือนให้" is hidden so the UI
 *     never advertises a reminder it won't send.
 *
 * What this does NOT touch (deliberately): the immediate group ANNOUNCEMENT
 * push on task create, recurring rollover (recurrence keeps advancing rounds),
 * and any existing task_reminders rows in the DB (left dormant, never wiped).
 */
export const TASK_NOTIFICATIONS_ENABLED = false;
