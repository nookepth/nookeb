'use client';

import { useMemo } from 'react';
import type { TaskDto } from '@nookeb/shared';
import { personalStats } from './taskInsights';
import styles from './tasks.module.css';

function TrendUpIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 17 10 11l4 4 6-7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 13V8h-5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function TrendDownIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 7 10 13l4-4 6 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 11v5h-5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** สถิติของฉัน — avg completions/week, on-time %, and where lateness happens
 * most, all derived client-side from the viewer's own assignee rows. Includes
 * a this-week-vs-last-week trend line (creative addition). */
export default function PersonalStatsSection({
  tasks,
  viewerUid,
}: {
  tasks: TaskDto[];
  viewerUid: string;
}) {
  const s = useMemo(() => personalStats(tasks, viewerUid), [tasks, viewerUid]);
  const maxLate = s.lateBuckets.length > 0 ? Math.max(...s.lateBuckets.map((b) => b.count)) : 0;
  const diff = s.thisWeek - s.lastWeek;

  return (
    <section className={styles.pStatsCard} aria-label="สถิติของฉัน">
      <h2 className={styles.activityTitle} style={{ marginBottom: 12 }}>
        สถิติของฉัน
      </h2>
      <div className={styles.metricRow}>
        <div className={styles.metricBox}>
          <span className={styles.metricNum}>{s.avgDonePerWeek}</span>
          <span className={styles.metricLabel}>งานเสร็จเฉลี่ย / สัปดาห์</span>
        </div>
        <div className={styles.metricBox}>
          <span className={`${styles.metricNum} ${s.onTimePct !== null && s.onTimePct >= 80 ? styles.metricNumDone : ''}`}>
            {s.onTimePct !== null ? `${s.onTimePct}%` : '—'}
          </span>
          <span className={styles.metricLabel}>เสร็จก่อน deadline</span>
        </div>
        <div className={styles.metricBox}>
          <span className={`${styles.metricNum} ${diff > 0 ? styles.metricNumDone : diff < 0 ? styles.metricNumOverdue : ''}`}>
            <span className={styles.trendIcon}>
              {diff > 0 ? <TrendUpIcon /> : diff < 0 ? <TrendDownIcon /> : null}
            </span>
            {s.thisWeek}
          </span>
          <span className={styles.metricLabel}>เสร็จสัปดาห์นี้ (ก่อนหน้า {s.lastWeek})</span>
        </div>
      </div>

      {s.lateBuckets.length > 0 ? (
        <div className={styles.lateSection}>
          <span className={styles.lateTitle}>งานที่เลยกำหนดบ่อยที่สุด</span>
          {s.lateBuckets.map((b) => (
            <div key={b.label} className={styles.lateRow}>
              <span className={styles.lateLabel}>{b.label}</span>
              <span className={styles.lateTrack}>
                <span
                  className={styles.lateFill}
                  style={{ width: `${maxLate > 0 ? Math.max((b.count / maxLate) * 100, 8) : 0}%` }}
                />
              </span>
              <span className={styles.lateCount}>{b.count}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className={styles.lateEmpty}>ยังไม่เคยมีงานเลยกำหนดเลย รักษาฟอร์มนี้ไว้น้า</p>
      )}
    </section>
  );
}
