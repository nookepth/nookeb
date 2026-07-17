import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import type { RecurrenceRule } from '@nookeb/shared';

dayjs.extend(utc);
dayjs.extend(timezone);

export const BANGKOK_TZ = 'Asia/Bangkok';

/**
 * ระบบตามงาน recurrence math — pure/env-free (unit-tested), split out of
 * taskScheduler so tests don't drag in the Redis/BullMQ/config imports.
 *
 * Next occurrence of a recurrence rule strictly after `after` (default now),
 * computed on the Asia/Bangkok wall clock. Monthly days clamp to the month's
 * last day (e.g. day 31 in April → April 30).
 */
export function computeNextOccurrence(rule: RecurrenceRule, after?: string | Date): Date {
  const [hourStr, minuteStr] = rule.time.split(':');
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const base = dayjs(after ?? new Date()).tz(BANGKOK_TZ);

  if (rule.freq === 'daily') {
    let next = base.hour(hour).minute(minute).second(0).millisecond(0);
    if (!next.isAfter(base)) next = next.add(1, 'day');
    return next.toDate();
  }

  if (rule.freq === 'weekly') {
    const weekday = rule.weekday ?? 1;
    let next = base.day(weekday).hour(hour).minute(minute).second(0).millisecond(0);
    while (!next.isAfter(base)) next = next.add(1, 'week');
    return next.toDate();
  }

  // monthly
  const dayOfMonth = rule.day ?? 1;
  let candidate = base.startOf('month');
  for (let i = 0; i < 3; i++) {
    const clamped = Math.min(dayOfMonth, candidate.daysInMonth());
    const next = candidate
      .date(clamped)
      .hour(hour)
      .minute(minute)
      .second(0)
      .millisecond(0);
    if (next.isAfter(base)) return next.toDate();
    candidate = candidate.add(1, 'month');
  }
  // Unreachable (3 months always contain a future occurrence) — satisfy TS.
  return candidate.date(Math.min(dayOfMonth, candidate.daysInMonth())).hour(hour).minute(minute).toDate();
}
