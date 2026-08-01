import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BANGKOK_OFFSET_MINUTES,
  MONTHLY_RESET_CRON,
  currentPeriodStart,
  periodResetAt,
  periodResetAtIso,
  periodStartAt,
  previousPeriodStart,
} from './billing-period';

/**
 * "All monthly quotas reset on the 1st of each month 00:00 ICT."
 *
 * Every case below is written as a UTC instant, because that is what the server
 * actually holds; the assertions are about which BANGKOK month it falls in. The
 * bugs these guard against are all off-by-seven-hours.
 */

describe('currentPeriodStart', () => {
  it('files a mid-month instant under that month', () => {
    assert.equal(currentPeriodStart(new Date('2026-08-15T09:00:00Z')), '2026-08-01');
  });

  it('files 00:30 ICT on the 1st under the NEW month, not the old one', () => {
    // 2026-08-01T00:30+07:00 === 2026-07-31T17:30Z. A naive UTC month read
    // would file this under July and grant a second July allowance.
    assert.equal(currentPeriodStart(new Date('2026-07-31T17:30:00Z')), '2026-08-01');
  });

  it('files 23:30 ICT on the last day under the OLD month', () => {
    // 2026-07-31T23:30+07:00 === 2026-07-31T16:30Z — still July in Bangkok.
    assert.equal(currentPeriodStart(new Date('2026-07-31T16:30:00Z')), '2026-07-01');
  });

  it('handles the exact reset instant as the first moment of the new period', () => {
    // 2026-09-01T00:00+07:00 === 2026-08-31T17:00Z
    assert.equal(currentPeriodStart(new Date('2026-08-31T17:00:00Z')), '2026-09-01');
    // one millisecond earlier is still August
    assert.equal(currentPeriodStart(new Date('2026-08-31T16:59:59.999Z')), '2026-08-01');
  });

  it('rolls the year over at the December → January boundary', () => {
    assert.equal(currentPeriodStart(new Date('2026-12-31T17:00:00Z')), '2027-01-01');
    assert.equal(currentPeriodStart(new Date('2026-12-31T16:59:59Z')), '2026-12-01');
  });

  it('zero-pads single-digit months', () => {
    assert.equal(currentPeriodStart(new Date('2026-03-05T00:00:00Z')), '2026-03-01');
    assert.match(currentPeriodStart(new Date('2026-01-05T00:00:00Z')), /^\d{4}-\d{2}-01$/);
  });

  it('handles a leap-year February', () => {
    assert.equal(currentPeriodStart(new Date('2028-02-29T12:00:00Z')), '2028-02-01');
  });
});

describe('periodResetAt', () => {
  it('returns next month\'s 1st at 00:00 ICT as a UTC instant', () => {
    // From mid-August 2026 → 2026-09-01T00:00+07:00 === 2026-08-31T17:00Z
    assert.equal(
      periodResetAt(new Date('2026-08-15T09:00:00Z')).toISOString(),
      '2026-08-31T17:00:00.000Z',
    );
  });

  it('crosses the year boundary from December', () => {
    assert.equal(
      periodResetAt(new Date('2026-12-10T00:00:00Z')).toISOString(),
      '2026-12-31T17:00:00.000Z',
    );
  });

  it('lands on the 1st for months of every length', () => {
    for (const iso of [
      '2026-01-15T00:00:00Z', // 31-day
      '2026-02-15T00:00:00Z', // 28-day
      '2028-02-15T00:00:00Z', // 29-day
      '2026-04-15T00:00:00Z', // 30-day
    ]) {
      const reset = periodResetAt(new Date(iso));
      // Read the instant back in Bangkok terms: it must be a 1st at 00:00.
      const bkk = new Date(reset.getTime() + BANGKOK_OFFSET_MINUTES * 60_000);
      assert.equal(bkk.getUTCDate(), 1, iso);
      assert.equal(bkk.getUTCHours(), 0, iso);
      assert.equal(bkk.getUTCMinutes(), 0, iso);
    }
  });

  it('is always strictly in the future relative to its input', () => {
    const now = new Date('2026-08-31T16:59:59Z');
    assert.ok(periodResetAt(now).getTime() > now.getTime());
  });

  it('exposes an ISO form for the QUOTA_EXCEEDED payload', () => {
    const at = new Date('2026-08-15T09:00:00Z');
    assert.equal(periodResetAtIso(at), periodResetAt(at).toISOString());
  });
});

describe('periodStartAt', () => {
  it('is the inverse of currentPeriodStart at the boundary', () => {
    const start = periodStartAt('2026-08-01');
    assert.equal(start.toISOString(), '2026-07-31T17:00:00.000Z');
    assert.equal(currentPeriodStart(start), '2026-08-01');
  });

  it('pairs with periodResetAt: this period ends where the next begins', () => {
    const mid = new Date('2026-08-15T00:00:00Z');
    assert.equal(periodResetAt(mid).getTime(), periodStartAt('2026-09-01').getTime());
  });
});

describe('previousPeriodStart', () => {
  it('steps back one month', () => {
    assert.equal(previousPeriodStart('2026-08-01'), '2026-07-01');
  });

  it('steps back across the year boundary', () => {
    assert.equal(previousPeriodStart('2026-01-01'), '2025-12-01');
  });

  it('walks back N months without drifting on short months', () => {
    let p = '2026-08-01';
    for (let i = 0; i < 12; i += 1) p = previousPeriodStart(p);
    assert.equal(p, '2025-08-01');
  });
});

describe('reset schedule', () => {
  it('fires on the 1st at midnight, with the timezone supplied separately', () => {
    // The cron must NOT be pre-shifted to UTC: 17:00 on "the last day" is a
    // different day number every month, which no cron expression can say.
    assert.equal(MONTHLY_RESET_CRON, '0 0 1 * *');
  });

  it('uses a fixed +7 offset (Thailand has no DST)', () => {
    assert.equal(BANGKOK_OFFSET_MINUTES, 420);
  });
});
