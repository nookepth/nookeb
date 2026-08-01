/**
 * Trash retention policy (§12) — FREE 5 days, PRO 30, PREMIUM 30.
 *
 * This module owns the POLICY. It deliberately does NOT schedule its own daily
 * sweep, because one already exists: the `purge_deleted` repeatable in
 * upload.worker.ts, which in a single pass handles files, stale processing
 * rows, diary objects, vault files, legacy boxes and orphaned scan temp
 * objects. Adding a second daily deleter would mean two jobs racing over the
 * same R2 objects for no benefit.
 *
 * So `purge.service.ts` calls `retentionDaysForPlan` from here, and the
 * retention numbers live in config/plans.ts with every other plan limit.
 *
 * The bug this file exists to prevent: the previous check was
 * `plan === 'pro' || plan === 'team'`. Introducing 'premium' would have
 * silently given every premium user the 5-day FREE retention — a paid
 * entitlement quietly downgraded by a string comparison.
 */

import { normalizePlan, TRASH_RETENTION_DAYS, type Plan } from '../config/plans';

/**
 * Optional overrides, used by the dry-run purge script and the tests to force a
 * window. `free` overrides the FREE tier; `paid` overrides pro AND premium
 * together, which is the shape the existing PURGE_RETENTION_DAYS /
 * TRASH_RETENTION_DAYS_PRO env pair can express.
 */
export interface RetentionOverrides {
  free?: number;
  paid?: number;
}

/**
 * Retention window for a raw `users.plan` value. An unknown or NULL plan
 * (ownerless legacy files) falls back to FREE — the shortest window, which is
 * the safe direction: it never promises retention that was not paid for.
 */
export function retentionDaysForPlan(
  rawPlan: string | null | undefined,
  overrides?: RetentionOverrides,
): number {
  const plan = normalizePlan(rawPlan);
  if (plan === 'free') return overrides?.free ?? TRASH_RETENTION_DAYS.free;
  return overrides?.paid ?? TRASH_RETENTION_DAYS[plan];
}

/** The cutoff instant for a plan: anything soft-deleted before this is purgeable. */
export function retentionCutoff(
  rawPlan: string | null | undefined,
  now: Date = new Date(),
  overrides?: RetentionOverrides,
): Date {
  const days = retentionDaysForPlan(rawPlan, overrides);
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * The widest window across all plans, in days. The purge query fetches
 * candidates with this cutoff (a superset) and then applies each row's own
 * plan cutoff — one query instead of one per plan.
 */
export function maxRetentionDays(): number {
  return Math.max(...Object.values(TRASH_RETENTION_DAYS));
}

/** The narrowest window — the free tier's, and the one reported as `cutoff`. */
export function minRetentionDays(): number {
  return Math.min(...Object.values(TRASH_RETENTION_DAYS));
}

/**
 * Is this row past ITS OWN plan's retention?
 *
 * Pure, so the purge's per-row decision is unit-testable without R2 or a DB.
 */
export function isPurgeable(
  row: { deleted_at: string | null; plan: string | null | undefined },
  now: Date = new Date(),
  overrides?: RetentionOverrides,
): boolean {
  if (!row.deleted_at) return false;
  return Date.parse(row.deleted_at) < retentionCutoff(row.plan, now, overrides).getTime();
}

/** Exposed for the settings UI: "your deleted files are kept for N days". */
export function retentionSummary(): Record<Plan, number> {
  return { ...TRASH_RETENTION_DAYS };
}
