'use client';

import { useRouter } from 'next/navigation';
import type { TaskDto } from '@nookeb/shared';
import { effectiveDeadline, formatRelativeDeadline, isOverdue } from './taskUtils';
import styles from './tasks.module.css';

function TargetIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
    </svg>
  );
}
function ChevronIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** "วันนี้มี N งานที่ต้องส่ง" — shown only when the viewer has tasks due today
 * or overdue. Red accent when any are overdue; collapsible (sessionStorage). */
export default function TodayFocusBanner({
  tasks,
  overdueCount,
  collapsed,
  onToggle,
}: {
  tasks: TaskDto[];
  overdueCount: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const router = useRouter();
  if (tasks.length === 0) return null;
  const urgent = overdueCount > 0;
  const shown = tasks.slice(0, 5);

  return (
    <section className={`${styles.focusBanner} ${urgent ? styles.focusUrgent : ''}`} aria-label="งานวันนี้">
      <button type="button" className={styles.focusHead} onClick={onToggle} aria-expanded={!collapsed}>
        <span className={styles.focusIcon}>
          <TargetIcon />
        </span>
        <span className={styles.focusTitle}>
          {urgent
            ? `มี ${overdueCount} งานเลยกำหนด และวันนี้ต้องส่งอีก ${tasks.length - overdueCount} งาน`
            : `วันนี้มี ${tasks.length} งานที่ต้องส่ง`}
        </span>
        <span className={`${styles.focusChevron} ${collapsed ? styles.focusChevronUp : ''}`}>
          <ChevronIcon />
        </span>
      </button>
      {!collapsed && (
        <ul className={styles.focusList}>
          {shown.map((t) => {
            const dl = effectiveDeadline(t);
            const over = isOverdue(t);
            return (
              <li key={t.id}>
                <button
                  type="button"
                  className={styles.focusItem}
                  onClick={() => router.push(`/dashboard/tasks/${t.id}`)}
                >
                  <span className={`${styles.focusDot} ${over ? styles.focusDotOverdue : ''}`} />
                  <span className={styles.focusItemTitle}>{t.title}</span>
                  {dl && (
                    <span className={`${styles.focusItemTime} ${over ? styles.focusItemTimeOverdue : ''}`}>
                      {formatRelativeDeadline(dl)}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
          {tasks.length > shown.length && (
            <li className={styles.focusMore}>และอีก {tasks.length - shown.length} งาน</li>
          )}
        </ul>
      )}
    </section>
  );
}
