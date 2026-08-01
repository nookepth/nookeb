import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPACITY_LIMITS,
  FEATURE_ACCESS,
  MONTHLY_FEATURES,
  MONTHLY_QUOTAS,
  PLANS,
  PLAN_PRICING,
  REMINDER_INTERVAL_CHOICES,
  REMINDER_POLICY,
  SUPPORT_SLA_HOURS,
  TRASH_RETENTION_DAYS,
  UNLIMITED,
  DIARY_ADDON_GIFT_BOX_QUOTA,
  effectiveMonthlyLimit,
  hasFeature,
  isUnlimited,
  limitFor,
  lockerLimitBytes,
  normalizePlan,
  planSummary,
  priceOf,
  slaHoursFor,
  validateReminderSelection,
} from './plans';

const GB = 1024 * 1024 * 1024;

/**
 * These tests are the executable copy of the feature matrix. Every number the
 * spec states appears here as a literal — if a limit is changed in plans.ts,
 * a test must be changed too, deliberately, rather than silently.
 */

describe('plan vocabulary', () => {
  it('normalizes the legacy "team" plan to premium', () => {
    assert.equal(normalizePlan('team'), 'premium');
  });

  it('falls back to free for unknown, null and undefined', () => {
    // Security-relevant: an unrecognised value must never unlock a paid feature.
    assert.equal(normalizePlan(null), 'free');
    assert.equal(normalizePlan(undefined), 'free');
    assert.equal(normalizePlan(''), 'free');
    assert.equal(normalizePlan('enterprise'), 'free');
    assert.equal(normalizePlan('PRO'), 'free'); // case-sensitive by design
  });

  it('round-trips the three real plans', () => {
    for (const p of PLANS) assert.equal(normalizePlan(p), p);
  });
});

describe('pricing (THB)', () => {
  it('matches the published price list exactly', () => {
    assert.deepEqual(PLAN_PRICING.free, { monthly: 0, yearly: null });
    assert.deepEqual(PLAN_PRICING.pro, { monthly: 79, yearly: 790 });
    assert.deepEqual(PLAN_PRICING.premium, { monthly: 149, yearly: 1490 });
  });

  it('reports no yearly price for free', () => {
    assert.equal(priceOf('free', 'yearly'), null);
    assert.equal(priceOf('free', 'monthly'), 0);
  });

  it('prices every paid cycle', () => {
    assert.equal(priceOf('pro', 'monthly'), 79);
    assert.equal(priceOf('pro', 'yearly'), 790);
    assert.equal(priceOf('premium', 'monthly'), 149);
    assert.equal(priceOf('premium', 'yearly'), 1490);
  });
});

describe('§1 locker storage', () => {
  it('gives free 1 GB with no referrals', () => {
    assert.equal(lockerLimitBytes('free', 0), 1 * GB);
  });

  it('adds 1 GB per referral', () => {
    assert.equal(lockerLimitBytes('free', 1), 2 * GB);
    assert.equal(lockerLimitBytes('free', 2), 3 * GB);
    assert.equal(lockerLimitBytes('free', 3), 4 * GB);
  });

  it('caps free at 4 GB no matter how many referrals', () => {
    assert.equal(lockerLimitBytes('free', 4), 4 * GB);
    assert.equal(lockerLimitBytes('free', 50), 4 * GB);
    assert.equal(lockerLimitBytes('free', Number.MAX_SAFE_INTEGER), 4 * GB);
  });

  it('ignores referrals on paid plans (they are flat)', () => {
    assert.equal(lockerLimitBytes('pro', 0), 15 * GB);
    assert.equal(lockerLimitBytes('pro', 99), 15 * GB);
    assert.equal(lockerLimitBytes('premium', 0), 60 * GB);
    assert.equal(lockerLimitBytes('premium', 99), 60 * GB);
  });

  it('treats negative and fractional referral counts safely', () => {
    assert.equal(lockerLimitBytes('free', -5), 1 * GB);
    assert.equal(lockerLimitBytes('free', 1.9), 2 * GB); // floored
  });
});

describe('monthly quotas', () => {
  it('matches the matrix row for row', () => {
    assert.deepEqual(MONTHLY_QUOTAS.group_files, { free: 50, pro: 500, premium: 1500 });
    assert.deepEqual(MONTHLY_QUOTAS.tasks, { free: 7, pro: 25, premium: 100 });
    assert.deepEqual(MONTHLY_QUOTAS.task_notifications, { free: 7, pro: 30, premium: 100 });
    assert.deepEqual(MONTHLY_QUOTAS.word_conversion_pages, { free: 10, pro: 30, premium: 100 });
    assert.deepEqual(MONTHLY_QUOTAS.scans, { free: 10, pro: 30, premium: 100 });
    assert.deepEqual(MONTHLY_QUOTAS.pdf_merges, { free: 10, pro: 30, premium: 100 });
    assert.deepEqual(MONTHLY_QUOTAS.gift_boxes, { free: 3, pro: 10, premium: 30 });
  });

  it('gives paid plans unlimited diary reminders and free exactly 5', () => {
    assert.equal(MONTHLY_QUOTAS.diary_reminders.free, 5);
    assert.ok(isUnlimited(MONTHLY_QUOTAS.diary_reminders.pro));
    assert.ok(isUnlimited(MONTHLY_QUOTAS.diary_reminders.premium));
  });

  it('never lets a higher plan have a lower limit', () => {
    for (const feature of MONTHLY_FEATURES) {
      const { free, pro, premium } = MONTHLY_QUOTAS[feature];
      const rank = (n: number): number => (isUnlimited(n) ? Number.POSITIVE_INFINITY : n);
      assert.ok(rank(pro) >= rank(free), `${feature}: pro < free`);
      assert.ok(rank(premium) >= rank(pro), `${feature}: premium < pro`);
    }
  });

  it('resolves limits through limitFor', () => {
    assert.equal(limitFor('free', 'scans'), 10);
    assert.equal(limitFor('premium', 'group_files'), 1500);
    assert.equal(limitFor('pro', 'vault_files'), 30);
    assert.equal(limitFor('free', 'group_boosts'), 0);
  });
});

describe('§10 vault + §3 boosts are capacity, not monthly', () => {
  it('caps vault items at 10 / 30 / 100', () => {
    assert.deepEqual(CAPACITY_LIMITS.vault_files, { free: 10, pro: 30, premium: 100 });
  });

  it('gives free zero boost slots, pro 1, premium 3', () => {
    assert.deepEqual(CAPACITY_LIMITS.group_boosts, { free: 0, pro: 1, premium: 3 });
  });

  it('treats 0 boosts as a real limit, not as unlimited', () => {
    // Regression guard: using 0 as an "unlimited" sentinel here would hand every
    // free user infinite boosts.
    assert.equal(isUnlimited(CAPACITY_LIMITS.group_boosts.free), false);
    assert.equal(UNLIMITED, -1);
  });
});

describe('§4b reminder interval selection', () => {
  it('offers exactly the five documented intervals', () => {
    assert.deepEqual([...REMINDER_INTERVAL_CHOICES], [3, 6, 24, 48, 72]);
  });

  it('allows free 1, pro 2, premium 4 checkboxes', () => {
    assert.equal(REMINDER_POLICY.free.maxSelectable, 1);
    assert.equal(REMINDER_POLICY.pro.maxSelectable, 2);
    assert.equal(REMINDER_POLICY.premium.maxSelectable, 4);
  });

  it('offers the SAME five options to every plan — only the count differs', () => {
    // FREE is not given a reduced or special menu; it picks 1 of the same 5.
    for (const p of PLANS) {
      for (const choice of REMINDER_INTERVAL_CHOICES) {
        assert.deepEqual(
          validateReminderSelection(p, [choice]),
          { ok: true, intervals: [choice] },
          `${p} must be able to pick ${choice}h`,
        );
      }
    }
  });

  it('accepts an empty selection, which schedules nothing (no fallback)', () => {
    for (const p of PLANS) {
      assert.deepEqual(validateReminderSelection(p, []), { ok: true, intervals: [] });
      assert.deepEqual(validateReminderSelection(p, null), { ok: true, intervals: [] });
      assert.deepEqual(validateReminderSelection(p, undefined), { ok: true, intervals: [] });
    }
  });

  it('has no deadline-only fallback flag left on any plan', () => {
    // Regression guard for the removal: the policy object must expose exactly
    // the two knobs, so a fallback cannot be reintroduced unnoticed.
    for (const p of PLANS) {
      assert.deepEqual(Object.keys(REMINDER_POLICY[p]).sort(), [
        'maxSelectable',
        'notifyOnlyPending',
      ]);
    }
  });

  it('rejects one more checkbox than the plan allows', () => {
    assert.deepEqual(validateReminderSelection('free', [24, 6]), {
      ok: false,
      code: 'TOO_MANY_INTERVALS',
      max: 1,
    });
    assert.deepEqual(validateReminderSelection('pro', [72, 24, 6]), {
      ok: false,
      code: 'TOO_MANY_INTERVALS',
      max: 2,
    });
    assert.deepEqual(validateReminderSelection('premium', [72, 48, 24, 6, 3]), {
      ok: false,
      code: 'TOO_MANY_INTERVALS',
      max: 4,
    });
  });

  it('accepts exactly the plan maximum', () => {
    assert.deepEqual(validateReminderSelection('free', [24]), { ok: true, intervals: [24] });
    assert.deepEqual(validateReminderSelection('pro', [6, 24]), { ok: true, intervals: [24, 6] });
    assert.deepEqual(validateReminderSelection('premium', [3, 6, 24, 48]), {
      ok: true,
      intervals: [48, 24, 6, 3],
    });
  });

  it("sorts furthest-out first so the schedule reads chronologically", () => {
    const res = validateReminderSelection('premium', [3, 72, 24]);
    assert.equal(res.ok, true);
    assert.deepEqual(res.ok && res.intervals, [72, 24, 3]);
  });

  it('dedupes before counting — a double-ticked box is not a second slot', () => {
    // A client bug that sends [24,24] must not fail a FREE user's single slot.
    assert.deepEqual(validateReminderSelection('free', [24, 24]), { ok: true, intervals: [24] });
  });

  it('rejects intervals outside the closed set', () => {
    for (const bad of [0, 1, 5, 12, 96, -3, 2.5]) {
      const res = validateReminderSelection('premium', [bad]);
      assert.deepEqual(res, { ok: false, code: 'INVALID_INTERVAL', max: 4 }, `interval ${bad}`);
    }
  });

  it('rejects an invalid value even when the count is within the limit', () => {
    assert.equal(validateReminderSelection('premium', [24, 99]).ok, false);
  });
});

describe('§4c / §14 / §15 / §16 feature gates', () => {
  it('gates task export to pro and above', () => {
    assert.equal(hasFeature('free', 'export_task_summary'), false);
    assert.equal(hasFeature('pro', 'export_task_summary'), true);
    assert.equal(hasFeature('premium', 'export_task_summary'), true);
  });

  it('gates Google Sheets to premium ONLY (pro must not have it)', () => {
    assert.equal(hasFeature('free', 'google_sheets'), false);
    assert.equal(hasFeature('pro', 'google_sheets'), false);
    assert.equal(hasFeature('premium', 'google_sheets'), true);
  });

  it('gates the performance report to premium ONLY', () => {
    assert.equal(hasFeature('free', 'performance_report'), false);
    assert.equal(hasFeature('pro', 'performance_report'), false);
    assert.equal(hasFeature('premium', 'performance_report'), true);
  });

  it('gates notify-only-non-submitters to pro and above', () => {
    assert.equal(hasFeature('free', 'notify_only_pending'), false);
    assert.equal(hasFeature('pro', 'notify_only_pending'), true);
    assert.equal(hasFeature('premium', 'notify_only_pending'), true);
    // REMINDER_POLICY must agree with FEATURE_ACCESS — two sources of the same
    // truth is exactly how a gate drifts open.
    for (const p of PLANS) {
      assert.equal(REMINDER_POLICY[p].notifyOnlyPending, FEATURE_ACCESS.notify_only_pending[p]);
    }
  });

  it('gates boosting to pro and above, consistently with the slot count', () => {
    for (const p of PLANS) {
      assert.equal(hasFeature(p, 'group_boost'), CAPACITY_LIMITS.group_boosts[p] > 0);
    }
  });

  it('gives the onboarding call to premium only', () => {
    assert.equal(hasFeature('premium', 'onboarding_call'), true);
    assert.equal(hasFeature('pro', 'onboarding_call'), false);
  });

  it('applies the referral storage bonus to free only', () => {
    assert.equal(hasFeature('free', 'referral_storage_bonus'), true);
    assert.equal(hasFeature('pro', 'referral_storage_bonus'), false);
    assert.equal(hasFeature('premium', 'referral_storage_bonus'), false);
  });
});

describe('§12 trash retention', () => {
  it('keeps free 5 days and both paid plans 30', () => {
    assert.deepEqual(TRASH_RETENTION_DAYS, { free: 5, pro: 30, premium: 30 });
  });
});

describe('หนูเก็บความทรงจำ add-on: gift box floor', () => {
  it('raises free and pro up to 15 gift boxes a month', () => {
    assert.equal(DIARY_ADDON_GIFT_BOX_QUOTA, 15);
    assert.equal(effectiveMonthlyLimit('free', 'gift_boxes', { diaryAddon: true }), 15);
    assert.equal(effectiveMonthlyLimit('pro', 'gift_boxes', { diaryAddon: true }), 15);
  });

  // The whole point of a FLOOR: buying an add-on must never cut a paid tier's
  // allowance (premium's 30) down to the add-on's number.
  it('never lowers a plan that already exceeds the floor', () => {
    assert.equal(effectiveMonthlyLimit('premium', 'gift_boxes', { diaryAddon: true }), 30);
  });

  it('leaves every other feature and every non-holder untouched', () => {
    for (const plan of PLANS) {
      for (const feature of MONTHLY_FEATURES) {
        assert.equal(
          effectiveMonthlyLimit(plan, feature),
          MONTHLY_QUOTAS[feature][plan],
          `${plan}/${feature} changed without the add-on`,
        );
      }
      // Holding it must move gift_boxes and nothing else.
      for (const feature of MONTHLY_FEATURES) {
        if (feature === 'gift_boxes') continue;
        assert.equal(
          effectiveMonthlyLimit(plan, feature, { diaryAddon: true }),
          MONTHLY_QUOTAS[feature][plan],
          `${plan}/${feature} moved for an add-on holder`,
        );
      }
    }
  });

  it('leaves an unlimited limit unlimited', () => {
    // diary_reminders is UNLIMITED on paid plans; a floor must not cap it.
    assert.ok(isUnlimited(effectiveMonthlyLimit('pro', 'diary_reminders', { diaryAddon: true })));
  });
});

describe('§18 support SLA', () => {
  it('derives 24h for free and pro, 4h for premium', () => {
    assert.deepEqual(SUPPORT_SLA_HOURS, { free: 24, pro: 24, premium: 4 });
    assert.equal(slaHoursFor('free'), 24);
    assert.equal(slaHoursFor('pro'), 24);
    assert.equal(slaHoursFor('premium'), 4);
  });

  it('resolves a legacy team plan to the premium SLA', () => {
    assert.equal(slaHoursFor(normalizePlan('team')), 4);
  });
});

describe('planSummary', () => {
  it('describes every plan without omitting a feature', () => {
    for (const p of PLANS) {
      const s = planSummary(p);
      assert.equal(s.plan, p);
      assert.equal(Object.keys(s.monthly).length, MONTHLY_FEATURES.length);
      assert.equal(s.trashRetentionDays, TRASH_RETENTION_DAYS[p]);
      assert.equal(s.slaHours, SUPPORT_SLA_HOURS[p]);
    }
  });

  it('reports the free plan referral ceiling as 4 GB', () => {
    assert.equal(planSummary('free').lockerBytes, 1 * GB);
    assert.equal(planSummary('free').lockerMaxBytesWithReferrals, 4 * GB);
  });

  it('reports paid ceilings equal to their flat allowance', () => {
    assert.equal(planSummary('pro').lockerMaxBytesWithReferrals, 15 * GB);
    assert.equal(planSummary('premium').lockerMaxBytesWithReferrals, 60 * GB);
  });
});
