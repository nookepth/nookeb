'use client';

import { useMemo, useState } from 'react';
import type { TaskDto } from '@nookeb/shared';
import { THAI_MONTHS } from './taskUtils';
import { dayKey, tasksByDay } from './taskInsights';
import styles from './tasks.module.css';

const WEEKDAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

function ArrowIcon({ dir, size = 16 }: { dir: 'left' | 'right'; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      style={dir === 'right' ? { transform: 'scaleX(-1)' } : undefined}
    >
      <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Hand-rolled month calendar (no date library): dots on days that have task
 * deadlines — red = overdue, brand = upcoming, green = done. Clicking a day
 * filters the list below to that day (page owns the selection). */
export default function TaskCalendar({
  tasks,
  selected,
  onSelect,
}: {
  tasks: TaskDto[];
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  const [view, setView] = useState(() => {
    const base = selected ? new Date(`${selected}T00:00:00`) : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const marks = useMemo(() => tasksByDay(tasks), [tasks]);
  const todayK = dayKey(new Date());

  const year = view.getFullYear();
  const month = view.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const move = (delta: number) => setView(new Date(year, month + delta, 1));

  return (
    <div className={styles.calCard}>
      <div className={styles.calHead}>
        <button type="button" className={styles.calNavBtn} onClick={() => move(-1)} aria-label="เดือนก่อนหน้า">
          <ArrowIcon dir="left" />
        </button>
        <span className={styles.calMonthLabel}>
          {THAI_MONTHS[month]} {year + 543}
        </span>
        <button type="button" className={styles.calNavBtn} onClick={() => move(1)} aria-label="เดือนถัดไป">
          <ArrowIcon dir="right" />
        </button>
      </div>
      <div className={styles.calGrid} role="grid">
        {WEEKDAYS.map((w) => (
          <span key={w} className={styles.calWeekday}>
            {w}
          </span>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <span key={`e${i}`} className={styles.calCellEmpty} />;
          const key = dayKey(new Date(year, month, day));
          const mark = marks.get(key);
          const isToday = key === todayK;
          const isSelected = key === selected;
          return (
            <button
              key={key}
              type="button"
              className={`${styles.calCell} ${isToday ? styles.calCellToday : ''} ${
                isSelected ? styles.calCellSelected : ''
              }`}
              aria-pressed={isSelected}
              aria-label={`${day} ${THAI_MONTHS[month]}${mark ? ` มี ${mark.count} งาน` : ''}`}
              onClick={() => onSelect(isSelected ? null : key)}
            >
              <span className={styles.calDayNum}>{day}</span>
              <span className={styles.calDots}>
                {mark && mark.hasOverdue && <span className={`${styles.calDot} ${styles.calDotOverdue}`} />}
                {mark && mark.count > 0 && !mark.hasOverdue && !mark.hasDone && <span className={styles.calDot} />}
                {mark && mark.hasOverdue && mark.count > 1 && <span className={styles.calDot} />}
                {mark && mark.hasDone && <span className={`${styles.calDot} ${styles.calDotDone}`} />}
              </span>
            </button>
          );
        })}
      </div>
      <div className={styles.calLegend}>
        <span className={styles.calLegendItem}>
          <span className={`${styles.calDot} ${styles.calDotOverdue}`} /> เลยกำหนด
        </span>
        <span className={styles.calLegendItem}>
          <span className={styles.calDot} /> มีงานส่ง
        </span>
        <span className={styles.calLegendItem}>
          <span className={`${styles.calDot} ${styles.calDotDone}`} /> เสร็จแล้ว
        </span>
      </div>
    </div>
  );
}
