'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { TaskDto } from '@nookeb/shared';
import { THAI_MONTHS } from './taskUtils';
import { dayKey, tasksByDay, type DayTask } from './taskInsights';
import styles from './tasks.module.css';

const WEEKDAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

/**
 * How many task chips a cell prints before collapsing into "+N".
 *
 * Three is the printed maximum, but a day holding exactly four still shows all
 * four rather than "3 + 1 อีก" — hiding a single item behind a counter costs
 * the reader a click to learn one title, which is the trade the counter exists
 * to avoid. Beyond that the counter earns its place.
 */
const MAX_CHIPS = 3;

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

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const TONE_CLASS: Record<DayTask['tone'], string> = {
  overdue: 'calChipOverdue',
  done: 'calChipDone',
  upcoming: 'calChipUpcoming',
};

/**
 * Hand-rolled month calendar (no date library). Each day cell now prints the
 * actual task titles due that day, tinted by state — brand for upcoming, red
 * for overdue, muted green with a strike for finished.
 *
 * Markup note: the cell is a plain `<div>`, NOT a button. The day number and
 * each task chip are their own buttons (select the day / open the task), and a
 * button inside a button is invalid HTML that browsers silently un-nest — which
 * is exactly what would happen if the old single-button cell had gained chips.
 */
export default function TaskCalendar({
  tasks,
  selected,
  onSelect,
}: {
  tasks: TaskDto[];
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  const router = useRouter();
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
  const thisMonth = new Date();
  const isCurrentMonth = year === thisMonth.getFullYear() && month === thisMonth.getMonth();

  return (
    <div className={styles.calCard}>
      <div className={styles.calHead}>
        <button type="button" className={styles.calNavBtn} onClick={() => move(-1)} aria-label="เดือนก่อนหน้า">
          <ArrowIcon dir="left" />
        </button>
        <span className={styles.calMonthLabel}>
          {THAI_MONTHS[month]} {year + 543}
        </span>
        <span className={styles.calHeadRight}>
          {!isCurrentMonth && (
            <button
              type="button"
              className={styles.calTodayBtn}
              onClick={() => setView(new Date(thisMonth.getFullYear(), thisMonth.getMonth(), 1))}
            >
              เดือนนี้
            </button>
          )}
          <button type="button" className={styles.calNavBtn} onClick={() => move(1)} aria-label="เดือนถัดไป">
            <ArrowIcon dir="right" />
          </button>
        </span>
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
          const dayTasks = mark?.tasks ?? [];
          const isToday = key === todayK;
          const isSelected = key === selected;
          // show everything when one extra chip is all it would take
          const shown = dayTasks.length <= MAX_CHIPS + 1 ? dayTasks : dayTasks.slice(0, MAX_CHIPS);
          const hidden = dayTasks.length - shown.length;

          return (
            <div
              key={key}
              role="gridcell"
              className={`${styles.calCell} ${isToday ? styles.calCellToday : ''} ${
                isSelected ? styles.calCellSelected : ''
              } ${dayTasks.length === 0 ? styles.calCellQuiet : ''}`}
            >
              <button
                type="button"
                className={styles.calDayBtn}
                aria-pressed={isSelected}
                aria-label={`${day} ${THAI_MONTHS[month]}${
                  mark ? ` มี ${mark.count} งาน` : ' ไม่มีงาน'
                }`}
                onClick={() => onSelect(isSelected ? null : key)}
              >
                <span className={styles.calDayNum}>{day}</span>
                {mark && mark.count > 0 && <span className={styles.calDayCount}>{mark.count}</span>}
              </button>

              {shown.length > 0 && (
                <div className={styles.calChips}>
                  {shown.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={`${styles.calChip} ${styles[TONE_CLASS[t.tone]]}`}
                      title={`${t.title} · ${hhmm(t.deadline)}${t.isPersonal ? ' · งานส่วนตัว' : ''}`}
                      onClick={() => router.push(`/dashboard/tasks/${t.id}`)}
                    >
                      <span className={styles.calChipTime}>{hhmm(t.deadline)}</span>
                      <span className={styles.calChipTitle}>{t.title}</span>
                    </button>
                  ))}
                  {hidden > 0 && (
                    <button
                      type="button"
                      className={styles.calChipMore}
                      onClick={() => onSelect(key)}
                      aria-label={`ดูงานทั้งหมด ${dayTasks.length} งานของวันที่ ${day}`}
                    >
                      +{hidden} งาน
                    </button>
                  )}
                </div>
              )}
            </div>
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
        <span className={styles.calLegendHint}>แตะชื่องานเพื่อเปิดดู · แตะวันที่เพื่อกรองรายการด้านล่าง</span>
      </div>
    </div>
  );
}
