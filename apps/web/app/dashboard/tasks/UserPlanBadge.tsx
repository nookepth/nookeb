'use client';

import styles from './tasks.module.css';

/** Plan badge — free = "หนูเก็บวัยเด็ก", pro/team = "หนูเก็บโตแย้ว". */
export default function UserPlanBadge({ plan }: { plan: string }) {
  const isFree = plan === 'free';
  return (
    <span className={`${styles.planBadge} ${isFree ? styles.planBadgeFree : styles.planBadgePro}`}>
      {isFree ? 'หนูเก็บวัยเด็ก' : 'หนูเก็บโตแย้ว'}
    </span>
  );
}
