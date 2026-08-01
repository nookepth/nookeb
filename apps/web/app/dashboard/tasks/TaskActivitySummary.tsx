'use client';

import { useMemo, useState } from 'react';
import type { TaskDto } from '@nookeb/shared';
import { completionTime, effectiveDeadline, isOverdue } from './taskUtils';
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

/**
 * สรุปกิจกรรม — derived entirely client-side from the already-loaded task array
 * (no extra endpoint). "งานที่เสร็จ" uses the latest assignee doneAt as the
 * completion time (tasks have no completedAt column).
 *
 * Counting rules, deliberately NOT the same as the ring's:
 * - งานที่สร้าง    = every task created in the window, cancelled INCLUDED
 *                    (this is intake volume, not progress — hence the footnote)
 * - งานที่เสร็จ    = status 'done' only, same set the เสร็จสิ้น card counts
 * - งานที่เลยกำหนด = `isOverdue` (the exact predicate behind the เลยกำหนด card)
 *                    restricted to deadlines inside the window
 *
 * RULE: cancelled tasks are NEVER counted in progress or completion rate. They
 * are displayed separately for visibility but excluded from all percentage
 * calculations. This panel shows raw counts, never a percentage, so the one
 * place it includes them (งานที่สร้าง) is labelled as such on screen.
 */
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
      // งานที่สร้าง counts EVERY status, cancelled included — intake volume
      if (inRange(t.createdAt, from, to)) created += 1;
      // งานที่เสร็จ — same set as the เสร็จสิ้น card, windowed by completion time
      if (t.status === 'done' && inRange(completionTime(t), from, to)) done += 1;
      // งานที่เลยกำหนด — the เลยกำหนด card's own predicate (live + deadline
      // passed, so done/cancelled are excluded), windowed by that deadline
      const dl = effectiveDeadline(t);
      if (isOverdue(t) && dl && inRange(dl, from, to)) overdue += 1;
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
        <div className={styles.metricBox} title="นับงานที่ยกเลิกด้วย">
          <span className={styles.metricNum}>{created}</span>
          <span className={styles.metricLabel}>งานที่สร้าง</span>
          <span className={styles.metricNote}>(รวมงานที่ยกเลิก)</span>
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
