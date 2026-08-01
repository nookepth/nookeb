/**
 * Billing period math — "all monthly quotas reset on the 1st of each month at
 * 00:00 ICT (UTC+7)".
 *
 * PURE AND ENV-FREE (project rule 14). No Date-locale calls, no Intl, no
 * dependency on the host timezone: the server runs in UTC on Railway and in
 * Asia/Bangkok on a developer laptop, and both must compute the same period.
 *
 * Thailand has had no DST since 1941 and a fixed UTC+7 offset, so a constant
 * offset is correct here — this is deliberately NOT a general-purpose tz
 * conversion. Do not reuse it for a timezone that observes DST.
 */

/** Asia/Bangkok is a fixed UTC+7. */
export const BANGKOK_OFFSET_MINUTES = 7 * 60;
const BANGKOK_OFFSET_MS = BANGKOK_OFFSET_MINUTES * 60 * 1000;

/** `YYYY-MM-DD` of the Bangkok calendar month start containing `at`. */
export type PeriodStart = string;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * The Bangkok wall-clock Y/M/D for an instant, read via a shifted UTC clock.
 * Shifting then reading UTC fields is the trick that keeps this independent of
 * the process timezone.
 */
function bangkokParts(at: Date): { year: number; month: number; day: number } {
  const shifted = new Date(at.getTime() + BANGKOK_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(), // 0-indexed
    day: shifted.getUTCDate(),
  };
}

/**
 * The current quota period key: the 1st of the Bangkok month containing `at`.
 * This is what goes into `user_quotas.period_start` (a DATE column).
 *
 * Edge case this exists for: 2026-08-01T00:30+07:00 is 2026-07-31T17:30Z. A
 * naive UTC month read would file that usage under July and hand the user a
 * second July allowance.
 */
export function currentPeriodStart(at: Date = new Date()): PeriodStart {
  const { year, month } = bangkokParts(at);
  return `${year}-${pad2(month + 1)}-01`;
}

/**
 * The instant the current period ends — i.e. next month's 1st at 00:00 ICT,
 * as a UTC Date. This is the `reset_at` in the QUOTA_EXCEEDED payload.
 *
 * Returned as an instant rather than a wall-clock string so clients in any
 * timezone can render a correct countdown.
 */
export function periodResetAt(at: Date = new Date()): Date {
  const { year, month } = bangkokParts(at);
  // Date.UTC normalises a month index of 12 into January of the next year, so
  // December needs no special case.
  return new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0) - BANGKOK_OFFSET_MS);
}

/** ISO-8601 form of {@link periodResetAt}, for the structured error payload. */
export function periodResetAtIso(at: Date = new Date()): string {
  return periodResetAt(at).toISOString();
}

/** The instant a given period key BEGAN, as a UTC Date. */
export function periodStartAt(period: PeriodStart): Date {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1, 0, 0, 0, 0) - BANGKOK_OFFSET_MS);
}

/** The period key immediately before `period` — used by the reset/cleanup job. */
export function previousPeriodStart(period: PeriodStart): PeriodStart {
  const [y, m] = period.split('-').map(Number);
  const month = m! - 1; // to 0-indexed
  const prev = new Date(Date.UTC(y!, month - 1, 1));
  return `${prev.getUTCFullYear()}-${pad2(prev.getUTCMonth() + 1)}-01`;
}

/**
 * A cron expression firing at 00:00 Asia/Bangkok on the 1st of every month.
 *
 * Expressed in UTC (17:00 on the LAST day of the previous month) would be
 * fragile across month lengths, so the scheduler is given the Bangkok
 * expression plus an explicit `tz` instead — BullMQ's repeat options accept an
 * IANA timezone, which is the only safe way to say "the 1st, local time".
 */
export const MONTHLY_RESET_CRON = '0 0 1 * *';
export const BANGKOK_TZ = 'Asia/Bangkok';
