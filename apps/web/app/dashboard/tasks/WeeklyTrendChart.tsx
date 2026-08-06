'use client';

import { useMemo } from 'react';
import type { TaskDto } from '@nookeb/shared';
import { THAI_MONTHS } from './taskUtils';
import styles from './tasks.module.css';

const WEEKS = 8;
const WEEK_MS = 7 * 86_400_000;

interface Bucket {
  label: string;
  created: number;
  done: number;
}

/**
 * แนวโน้มรายสัปดาห์ — งานที่สร้าง vs งานที่ปิดได้ over the last eight
 * Monday-start weeks, hand-rolled CSS bars (the project has no chart library
 * and §2 says not to add one).
 *
 * "Done" is counted by the viewer's own `doneAt` stamps, the same signal
 * สถิติของฉัน uses, so the two panels can never disagree. A task carrying no
 * doneAt (closed before the column existed, or closed by someone else) is in
 * neither series — the axis note says so on screen.
 */
export default function WeeklyTrendChart({ tasks, viewerUid }: { tasks: TaskDto[]; viewerUid: string }) {
  const buckets = useMemo<Bucket[]>(() => {
    const monday = new Date();
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const thisWeekStart = monday.getTime();

    const out: Bucket[] = [];
    for (let i = WEEKS - 1; i >= 0; i -= 1) {
      const start = thisWeekStart - i * WEEK_MS;
      const d = new Date(start);
      out.push({
        label: i === 0 ? 'สัปดาห์นี้' : `${d.getDate()} ${THAI_MONTHS[d.getMonth()]}`,
        created: 0,
        done: 0,
      });
    }
    /**
     * Bucket index for a timestamp. `ceil`, not `floor`: a moment one hour
     * before this Monday is a whole week ago in calendar terms even though the
     * elapsed time rounds down to zero weeks. Flooring counted the entire
     * previous week into "สัปดาห์นี้" and shifted every older bar one column
     * late — the newest bar always looked inflated and last week always looked
     * empty. Returns a value outside 0..WEEKS-1 for anything off the chart.
     */
    const indexOf = (ms: number): number => {
      const behind = thisWeekStart - ms;
      const weeksAgo = behind <= 0 ? 0 : Math.ceil(behind / WEEK_MS);
      return WEEKS - 1 - weeksAgo;
    };

    for (const t of tasks) {
      const created = out[indexOf(new Date(t.createdAt).getTime())];
      if (created) created.created += 1;
      for (const item of t.items) {
        for (const a of item.assignees) {
          if (a.lineUid !== viewerUid || !a.doneAt) continue;
          const done = out[indexOf(new Date(a.doneAt).getTime())];
          if (done) done.done += 1;
        }
      }
    }
    return out;
  }, [tasks, viewerUid]);

  const max = Math.max(1, ...buckets.map((b) => Math.max(b.created, b.done)));

  return (
    <section className={styles.trendCard} aria-label="แนวโน้มรายสัปดาห์">
      <div className={styles.activityHead}>
        <h2 className={styles.activityTitle}>แนวโน้ม 8 สัปดาห์ล่าสุด</h2>
        <div className={styles.trendLegend}>
          <span className={styles.trendLegendItem}>
            <span className={`${styles.trendSwatch} ${styles.trendSwatchCreated}`} /> งานที่เข้ามา
          </span>
          <span className={styles.trendLegendItem}>
            <span className={`${styles.trendSwatch} ${styles.trendSwatchDone}`} /> ฉันปิดได้
          </span>
        </div>
      </div>
      <div className={styles.trendChart} role="img" aria-label="กราฟแท่งเปรียบเทียบงานที่เข้ามากับงานที่ปิดได้">
        {buckets.map((b, i) => (
          <div key={i} className={styles.trendCol}>
            <div className={styles.trendBars}>
              <span
                className={`${styles.trendBar} ${styles.trendBarCreated}`}
                style={{ height: `${(b.created / max) * 100}%` }}
                title={`งานที่เข้ามา ${b.created}`}
              />
              <span
                className={`${styles.trendBar} ${styles.trendBarDone}`}
                style={{ height: `${(b.done / max) * 100}%` }}
                title={`ฉันปิดได้ ${b.done}`}
              />
            </div>
            <span className={styles.trendLabel}>{b.label}</span>
          </div>
        ))}
      </div>
      <p className={styles.trendFoot}>
        นับจากเวลาที่สร้างงาน และเวลาที่เธอกดเสร็จเอง — งานที่คนอื่นปิดให้จะไม่อยู่ในแท่งสีเขียวน้า
      </p>
    </section>
  );
}
