'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import type { TaskDto } from '@nookeb/shared';
import { buildActivityFeed, timeAgo, type ActivityKind } from './taskInsights';
import styles from './tasks.module.css';

const KIND_LABEL: Record<ActivityKind, string> = {
  created: 'สร้างงาน',
  done: 'เสร็จแล้ว',
  cancelled: 'ยกเลิก',
};

function ChevronIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function PulseIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M3 12h4l2.5-6 4 12 2.5-6h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const DOT_CLASS: Record<ActivityKind, string> = {
  created: '',
  done: 'feedDotDone',
  cancelled: 'feedDotCancelled',
};

/** ความเคลื่อนไหวล่าสุด — last 20 events derived client-side (created /
 * completed / cancelled). Collapsible; rows link to the task. */
export default function ActivityFeed({
  tasks,
  collapsed,
  onToggle,
}: {
  tasks: TaskDto[];
  collapsed: boolean;
  onToggle: () => void;
}) {
  const router = useRouter();
  const events = useMemo(() => buildActivityFeed(tasks, 20), [tasks]);

  return (
    <section className={styles.feedCard} aria-label="ความเคลื่อนไหวล่าสุด">
      <button type="button" className={styles.feedHead} onClick={onToggle} aria-expanded={!collapsed}>
        <span className={styles.feedHeadIcon}>
          <PulseIcon />
        </span>
        <span className={styles.feedTitle}>ความเคลื่อนไหวล่าสุด</span>
        <span className={`${styles.focusChevron} ${collapsed ? styles.focusChevronUp : ''}`}>
          <ChevronIcon />
        </span>
      </button>
      {!collapsed &&
        (events.length === 0 ? (
          <p className={styles.feedEmpty}>พอมีอะไรเกิดขึ้นกับงานของเธอ หนูจะจดไว้ตรงนี้ให้เลยน้า</p>
        ) : (
          <ul className={styles.feedList}>
            {events.map((ev) => (
              <li key={ev.id}>
                <button
                  type="button"
                  className={styles.feedItem}
                  onClick={() => router.push(`/dashboard/tasks/${ev.taskId}`)}
                >
                  <span
                    className={`${styles.feedDot} ${
                      DOT_CLASS[ev.kind] ? styles[DOT_CLASS[ev.kind]] : ''
                    }`}
                  />
                  <span className={styles.feedText}>
                    <span className={styles.feedKind}>{KIND_LABEL[ev.kind]}</span> {ev.taskTitle}
                  </span>
                  <span className={styles.feedTime}>{timeAgo(ev.at)}</span>
                </button>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
