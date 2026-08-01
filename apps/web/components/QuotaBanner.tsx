'use client';

import type { QuotaStateDto } from '@/lib/api';
import { daysUntilReset } from '@/lib/quota-errors';
import styles from './QuotaBanner.module.css';

/**
 * The inline half of the quota story.
 *
 * A counter on a list page ("ใช้ไปแล้ว 3/3 กล่องเดือนนี้") is shown on load,
 * with no action to interrupt — so a modal would be an ambush. This sits under
 * the counter instead and says the two things the number alone doesn't: when it
 * comes back, and what a bigger plan would give.
 *
 * Renders nothing below 80 % (and never for an unlimited feature): a quiet
 * counter is the correct UI for a quota with room left in it.
 */

/** 0.8 — the point where "you have plenty" stops being true. */
const NEAR_FULL = 0.8;

export type QuotaLevel = 'ok' | 'near' | 'full';

/**
 * Shared by the banner and by the counter's own styling, so the two can never
 * disagree about whether a quota is full.
 */
export function quotaLevel(q: QuotaStateDto | null | undefined): QuotaLevel {
  if (!q || q.unlimited || q.limit <= 0) return 'ok';
  if (q.used >= q.limit) return 'full';
  return q.used / q.limit >= NEAR_FULL ? 'near' : 'ok';
}

export function QuotaBanner({
  quota,
  resetAt,
  /** The counting noun for this feature — "เหลืออีก 2 กล่อง". */
  unit = 'ครั้ง',
}: {
  quota: QuotaStateDto | null | undefined;
  resetAt?: string | null;
  unit?: string;
}) {
  const level = quotaLevel(quota);
  if (level === 'ok' || !quota) return null;

  if (level === 'near') {
    const remaining = Math.max(0, quota.limit - quota.used);
    return (
      <p className={`${styles.banner} ${styles.near}`} role="status">
        ใกล้เต็มแล้วน้า เหลืออีก {remaining} {unit}
      </p>
    );
  }

  return (
    <p className={`${styles.banner} ${styles.full}`} role="status">
      <span>โควต้าเดือนนี้เต็มแล้ว</span>
      <span className={styles.sep} aria-hidden>
        ·
      </span>
      <span>รีเซตอีก {daysUntilReset(resetAt)} วัน</span>
      <span className={styles.sep} aria-hidden>
        ·
      </span>
      <a className={styles.cta} href="/dashboard/plans">
        อัปเกรด →
      </a>
    </p>
  );
}

export default QuotaBanner;
