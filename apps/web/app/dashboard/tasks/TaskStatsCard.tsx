'use client';

import type { ReactNode } from 'react';
import styles from './tasks.module.css';

export type StatTone = 'progress' | 'overdue' | 'done' | 'cancelled';

const TONE_CLASS: Record<StatTone, string> = {
  progress: styles.statToneProgress ?? '',
  overdue: styles.statToneOverdue ?? '',
  done: styles.statToneDone ?? '',
  cancelled: styles.statToneCancelled ?? '',
};

/** One clickable KPI card in the stats grid — clicking filters the list below. */
export default function TaskStatsCard({
  icon,
  count,
  label,
  tone,
  active,
  onClick,
}: {
  icon: ReactNode;
  count: number;
  label: string;
  tone: StatTone;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.statCard} ${active ? styles.statCardActive : ''}`}
      onClick={onClick}
      aria-pressed={active}
    >
      <span className={`${styles.statIcon} ${TONE_CLASS[tone]}`}>{icon}</span>
      <span className={styles.statNum}>{count}</span>
      <span className={styles.statLabel}>{label}</span>
    </button>
  );
}
