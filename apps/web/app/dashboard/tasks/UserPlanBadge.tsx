'use client';

import { planDisplayName } from '@/lib/quota-errors';
import styles from './tasks.module.css';

/**
 * Plan pill — free = "หนูเก็บวัยเด็ก", pro = "หนูเก็บโตแย้ว",
 * premium = "หนูเก็บแปลงร่าง". NO EMOJI on tier names (brand rule).
 *
 * The name comes from lib/quota-errors.ts rather than a local ternary: the old
 * version only knew two tiers, so a premium user was labelled "หนูเก็บโตแย้ว"
 * — the tier below the one they pay for.
 */
export default function UserPlanBadge({ plan }: { plan: string }) {
  const isFree = plan === 'free';
  return (
    <span className={`${styles.planBadge} ${isFree ? styles.planBadgeFree : styles.planBadgePro}`}>
      {planDisplayName(plan)}
    </span>
  );
}
