import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planAllows, resolveReminderConfig } from './planGuard';
import { REMINDER_INTERVAL_CHOICES } from '../config/plans';
import { retentionDaysForPlan, isPurgeable, maxRetentionDays, minRetentionDays } from '../jobs/trashCleanup.job';

/**
 * planGuard's route middleware needs a Fastify request, so what is unit-tested
 * here is the pure decision surface it is built on: `planAllows` (used by the
 * workers, where there is no request at all) and `resolveReminderConfig` (a
 * body-field limit that cannot be a preHandler).
 */

describe('planAllows', () => {
  it('answers from a raw DB plan string', () => {
    assert.equal(planAllows('premium', 'google_sheets'), true);
    assert.equal(planAllows('pro', 'google_sheets'), false);
    assert.equal(planAllows('free', 'google_sheets'), false);
  });

  it('treats the legacy team plan as premium', () => {
    assert.equal(planAllows('team', 'google_sheets'), true);
    assert.equal(planAllows('team', 'performance_report'), true);
  });

  it('denies for null / unknown plans rather than defaulting open', () => {
    assert.equal(planAllows(null, 'google_sheets'), false);
    assert.equal(planAllows(undefined, 'export_task_summary'), false);
    assert.equal(planAllows('lifetime-vip', 'performance_report'), false);
  });
});

describe('resolveReminderConfig — §4b checkbox limit', () => {
  it('accepts an empty selection, which schedules nothing', () => {
    for (const plan of ['free', 'pro', 'premium'] as const) {
      const res = resolveReminderConfig({ plan, intervals: [] });
      assert.equal(res.ok, true);
      assert.deepEqual(res.ok && res.intervals, []);
    }
  });

  it('lets FREE pick any ONE of the same thirteen intervals', () => {
    for (const choice of REMINDER_INTERVAL_CHOICES) {
      const res = resolveReminderConfig({ plan: 'free', intervals: [choice] });
      assert.equal(res.ok, true, `free must be able to pick ${choice}m`);
      assert.deepEqual(res.ok && res.intervals, [choice]);
    }
  });

  it('rejects a second interval on free with 403 + a machine code', () => {
    const res = resolveReminderConfig({ plan: 'free', intervals: [1440, 360] });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'REMINDER_INTERVAL_LIMIT');
    assert.equal(res.body.limit, 1);
  });

  it("honours the spec's PRO example: [6h, 1d] → notified 1 day before AND 6h before", () => {
    const res = resolveReminderConfig({ plan: 'pro', intervals: [360, 1440] });
    assert.equal(res.ok, true);
    assert.deepEqual(res.ok && res.intervals, [1440, 360]);
  });

  it('rejects a third interval on pro', () => {
    const res = resolveReminderConfig({ plan: 'pro', intervals: [360, 1440, 4320] });
    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.body.limit, 2);
  });

  it('lets premium pick four but not five', () => {
    assert.equal(
      resolveReminderConfig({ plan: 'premium', intervals: [180, 360, 1440, 2880] }).ok,
      true,
    );
    assert.equal(
      resolveReminderConfig({ plan: 'premium', intervals: [180, 360, 1440, 2880, 4320] }).ok,
      false,
    );
  });

  it('rejects an off-menu interval with 400, not 403', () => {
    // A bad value is a malformed request; a too-long selection is a plan limit.
    // Distinguishing them is what lets the client show the right message.
    const res = resolveReminderConfig({ plan: 'premium', intervals: [7] });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_REMINDER_INTERVAL');
  });

  it('is enforced server-side regardless of what the client sends', () => {
    // The whole point of §4b's "not just client-side" note.
    const res = resolveReminderConfig({ plan: 'free', intervals: [180, 360, 1440, 2880, 4320] });
    assert.equal(res.ok, false);
  });
});

describe('resolveReminderConfig — §4c notify only non-submitters', () => {
  it('refuses the toggle on free', () => {
    const res = resolveReminderConfig({ plan: 'free', notifyOnlyPending: true });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'PLAN_UPGRADE_REQUIRED');
    assert.equal(res.body.feature, 'notify_only_pending');
    assert.equal(res.body.required_plan, 'pro');
  });

  it('allows it on pro and premium', () => {
    for (const plan of ['pro', 'premium'] as const) {
      const res = resolveReminderConfig({ plan, notifyOnlyPending: true });
      assert.equal(res.ok, true);
      assert.equal(res.ok && res.notifyOnlyPending, true);
    }
  });

  it('does not reject a free user who leaves the toggle off', () => {
    for (const value of [false, null, undefined]) {
      const res = resolveReminderConfig({ plan: 'free', notifyOnlyPending: value });
      assert.equal(res.ok, true);
      assert.equal(res.ok && res.notifyOnlyPending, false);
    }
  });

  it('checks the interval limit BEFORE the toggle', () => {
    // Both invalid: the count error is the more specific one and should win, so
    // a free user fixing the toggle alone does not get a second rejection.
    const res = resolveReminderConfig({
      plan: 'free',
      intervals: [1440, 360],
      notifyOnlyPending: true,
    });
    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.body.code, 'REMINDER_INTERVAL_LIMIT');
  });
});

describe('§12 trash retention policy', () => {
  it('resolves 5 days for free and 30 for both paid plans', () => {
    assert.equal(retentionDaysForPlan('free'), 5);
    assert.equal(retentionDaysForPlan('pro'), 30);
    assert.equal(retentionDaysForPlan('premium'), 30);
  });

  it('gives PREMIUM the paid window — the bug the plan table exists to prevent', () => {
    // The old check was `plan === 'pro' || plan === 'team'`, which would have
    // silently handed a premium user the 5-day free window.
    assert.notEqual(retentionDaysForPlan('premium'), retentionDaysForPlan('free'));
    assert.equal(retentionDaysForPlan('team'), 30);
  });

  it('falls back to the SHORTEST window for an unknown or ownerless plan', () => {
    assert.equal(retentionDaysForPlan(null), 5);
    assert.equal(retentionDaysForPlan(undefined), 5);
    assert.equal(retentionDaysForPlan('mystery'), 5);
  });

  it('reports the correct min/max for the purge query bounds', () => {
    assert.equal(minRetentionDays(), 5);
    assert.equal(maxRetentionDays(), 30);
  });

  it('purges a free file at 6 days but not at 4', () => {
    const now = new Date('2026-08-20T00:00:00Z');
    const daysAgo = (n: number): string =>
      new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(isPurgeable({ deleted_at: daysAgo(6), plan: 'free' }, now), true);
    assert.equal(isPurgeable({ deleted_at: daysAgo(4), plan: 'free' }, now), false);
  });

  it('keeps a premium file that a free file would already have lost', () => {
    const now = new Date('2026-08-20T00:00:00Z');
    const sixDaysAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(isPurgeable({ deleted_at: sixDaysAgo, plan: 'premium' }, now), false);
    assert.equal(isPurgeable({ deleted_at: sixDaysAgo, plan: 'free' }, now), true);
  });

  it('purges a premium file past 30 days', () => {
    const now = new Date('2026-08-20T00:00:00Z');
    const thirtyOne = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(isPurgeable({ deleted_at: thirtyOne, plan: 'premium' }, now), true);
  });

  it('never purges a live (never-deleted) row', () => {
    assert.equal(isPurgeable({ deleted_at: null, plan: 'free' }), false);
  });

  it('honours an explicit override, so the dry-run script can force a window', () => {
    const now = new Date('2026-08-20T00:00:00Z');
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(isPurgeable({ deleted_at: twoDaysAgo, plan: 'free' }, now), false);
    assert.equal(
      isPurgeable({ deleted_at: twoDaysAgo, plan: 'free' }, now, { free: 1 }),
      true,
    );
  });
});
