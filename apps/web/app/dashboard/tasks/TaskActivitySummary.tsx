'use client';

import { useMemo, useState } from 'react';
import type { TaskDto } from '@nookeb/shared';
import { completionTime, effectiveDeadline } from './taskUtils';
import styles from './tasks.module.css';

type Range = 'today' | '7d' | 'month' | 'custom';

const RANGE_LABEL: Record<Range, string> = {
  today: 'วันนี้',
  '7d': '7 วัน',
  month: 'เดือนนี้',
  custom: 'กำหนดเอง',
};

function inRange(iso: string | null, from: number, to: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= from && t <= to;
}

/** สรุปกิจกรรม — derived entirely client-side from the already-loaded task
 * array (no extra endpoint). "งานที่เสร็จ" uses the latest assignee doneAt as
 * the completion time (tasks have no completedAt column). */
export default function TaskActivitySummary({ tasks }: { tasks: TaskDto[] }) {
  const [range, setRange] = useState<Range>('7d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const { created, done, overdue } = useMemo(() => {
    const now = Date.now();
    let from = 0;
    let to = now;
    if (range === 'today') {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      from = d.getTime();
    } else if (range === '7d') {
      from = now - 7 * 24 * 60 * 60 * 1000;
    } else if (range === 'month') {
      const d = new Date();
      d.setDate(1);
      d.setHours(0, 0, 0, 0);
      from = d.getTime();
    } else {
      from = customFrom ? new Date(`${customFrom}T00:00:00`).getTime() : 0;
      to = customTo ? new Date(`${customTo}T23:59:59.999`).getTime() : now;
    }
    if (Number.isNaN(from) || Number.isNaN(to) || from > to) {
      return { created: 0, done: 0, overdue: 0 };
    }
    let created = 0;
    let done = 0;
    let overdue = 0;
    for (const t of tasks) {
      if (inRange(t.createdAt, from, to)) created += 1;
      if (t.status === 'done' && inRange(completionTime(t), from, to)) done += 1;
      const dl = effectiveDeadline(t);
      // overdue in period: deadline fell inside the window, already passed,
      // and the task is still live
      if (
        t.status !== 'done' &&
        t.status !== 'cancelled' &&
        dl &&
        new Date(dl).getTime() < now &&
        inRange(dl, from, to)
      ) {
        overdue += 1;
      }
    }
    return { created, done, overdue };
  }, [tasks, range, customFrom, customTo]);

  return (
    <section className={styles.activityCard} aria-label="สรุปกิจกรรม">
      <div className={styles.activityHead}>
        <h2 className={styles.activityTitle}>สรุปกิจกรรม</h2>
        <div className={styles.segmented} role="group" aria-label="ช่วงเวลา">
          {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
            <button
              key={r}
              type="button"
              className={`${styles.segBtn} ${range === r ? styles.segBtnActive : ''}`}
              onClick={() => setRange(r)}
              aria-pressed={range === r}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
      </div>

      {range === 'custom' && (
        <div className={styles.customRange}>
          <label className={styles.customRangeField}>
            <span className={styles.fieldLabel}>ตั้งแต่</span>
            <input
              type="date"
              className={styles.input}
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
            />
          </label>
          <label className={styles.customRangeField}>
            <span className={styles.fieldLabel}>ถึง</span>
            <input
              type="date"
              className={styles.input}
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
            />
          </label>
        </div>
      )}

      <div className={styles.metricRow}>
        <div className={styles.metricBox}>
          <span className={styles.metricNum}>{created}</span>
          <span className={styles.metricLabel}>งานที่สร้าง</span>
        </div>
        <div className={styles.metricBox}>
          <span className={`${styles.metricNum} ${styles.metricNumDone}`}>{done}</span>
          <span className={styles.metricLabel}>งานที่เสร็จ</span>
        </div>
        <div className={styles.metricBox}>
          <span className={`${styles.metricNum} ${styles.metricNumOverdue}`}>{overdue}</span>
          <span className={styles.metricLabel}>งานที่เลยกำหนด</span>
        </div>
      </div>
    </section>
  );
}
