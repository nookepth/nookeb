'use client';

import { useEffect, useMemo, useRef } from 'react';
import type { TaskDto } from '@nookeb/shared';
import { characterSrc, rosterStats } from './mascots';
import { timeAgo } from './taskInsights';
import styles from './tasks.module.css';

/**
 * รายงานทีม — one row per person who holds at least one assignee slot, with the
 * same character image their floating mascot uses, so the two surfaces read as
 * one roster rather than two unrelated lists.
 *
 * Two caveats printed IN the card, not just here (same rule the Sheets
 * per-person tab follows): a blank ตรงเวลา means "not measurable" (that person
 * has finished nothing that carried a deadline), never 0%; and งานที่ยกเลิก is
 * excluded from every count, so a cancelled project cannot drag someone's
 * numbers down for a decision that was not theirs.
 */
export default function TeamReportSection({
  tasks,
  viewerUid,
  highlightUid,
}: {
  tasks: TaskDto[];
  viewerUid: string;
  /** set when a floating mascot was clicked — that row gets a ring */
  highlightUid?: string | null;
}) {
  const roster = useMemo(() => rosterStats(tasks, viewerUid), [tasks, viewerUid]);
  const hiRef = useRef<HTMLLIElement | null>(null);

  /**
   * Bring the highlighted row into view.
   *
   * Tapping a floating mascot jumps here and rings that person's row, but the
   * zone switch also scrolls the page to the top — so on any roster longer than
   * a screen the ring landed below the fold and the jump looked like it had
   * simply done nothing. The scroll is deferred a frame so it runs AFTER the
   * zone switch's own smooth scroll-to-top has been issued, and `block:'center'`
   * keeps the row clear of the sticky zone nav.
   */
  useEffect(() => {
    if (!highlightUid) return;
    const id = requestAnimationFrame(() => {
      hiRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => cancelAnimationFrame(id);
  }, [highlightUid]);

  const totals = useMemo(
    () =>
      roster.reduce(
        (acc, p) => ({
          total: acc.total + p.total,
          done: acc.done + p.done,
          overdue: acc.overdue + p.overdue,
        }),
        { total: 0, done: 0, overdue: 0 },
      ),
    [roster],
  );

  if (roster.length === 0) {
    return (
      <div className={styles.emptyCard}>
        <h2 className={styles.emptyTitle}>ยังไม่มีใครถูกมอบหมายงานเลยน้า</h2>
        <p className={styles.emptyBody}>
          พอมอบหมายงานให้ใครในกลุ่ม LINE หนูจะสรุปให้เห็นเลยว่าใครรับไปเท่าไหร่ เสร็จเท่าไหร่
        </p>
      </div>
    );
  }

  const donePct = totals.total > 0 ? Math.round((totals.done / totals.total) * 100) : 0;

  return (
    <>
      <div className={styles.metricRow} style={{ marginBottom: 14 }}>
        <div className={styles.metricBox}>
          <span className={styles.metricNum}>{roster.length}</span>
          <span className={styles.metricLabel}>คนที่มีงานอยู่</span>
        </div>
        <div className={styles.metricBox}>
          <span className={`${styles.metricNum} ${styles.metricNumDone}`}>{donePct}%</span>
          <span className={styles.metricLabel}>เสร็จทั้งหมด</span>
          <span className={styles.metricNote}>
            ({totals.done}/{totals.total} รายการ)
          </span>
        </div>
        <div className={styles.metricBox}>
          <span className={`${styles.metricNum} ${totals.overdue > 0 ? styles.metricNumOverdue : ''}`}>
            {totals.overdue}
          </span>
          <span className={styles.metricLabel}>รายการที่เลยกำหนด</span>
        </div>
      </div>

      <section className={styles.rosterCard} aria-label="สรุปงานรายคน">
        <header className={styles.rosterHead}>
          <span className={styles.rosterHeadName}>สมาชิก</span>
          <span className={styles.rosterHeadCell}>ทั้งหมด</span>
          <span className={styles.rosterHeadCell}>เสร็จ</span>
          <span className={styles.rosterHeadCell}>ค้าง</span>
          <span className={styles.rosterHeadCell}>เลยกำหนด</span>
          <span className={styles.rosterHeadCell}>ตรงเวลา</span>
        </header>
        <ul className={styles.rosterList}>
          {roster.map((p) => {
            const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
            const coaching = p.onTimePct !== null && p.onTimePct < 70;
            return (
              <li
                key={p.lineUid}
                ref={highlightUid === p.lineUid ? hiRef : undefined}
                className={`${styles.rosterRow} ${highlightUid === p.lineUid ? styles.rosterRowHi : ''} ${
                  coaching ? styles.rosterRowCoach : ''
                }`}
              >
                <span className={styles.rosterName}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- static sprite */}
                  <img className={styles.rosterAvatar} src={characterSrc(p.characterIndex)} alt="" />
                  <span className={styles.rosterNameText}>
                    <span className={styles.rosterNameMain}>
                      {p.name}
                      {p.isMe && <span className={styles.rosterMeChip}>ฉัน</span>}
                    </span>
                    <span className={styles.rosterNameSub}>
                      {p.nameMissing
                        ? 'LINE ไม่ได้ส่งชื่อมาตอนมอบหมาย'
                        : p.lastDoneAt
                          ? `เสร็จล่าสุด ${timeAgo(p.lastDoneAt)}`
                          : 'ยังไม่เคยปิดงาน'}
                    </span>
                  </span>
                </span>
                <span className={styles.rosterCell}>{p.total}</span>
                <span className={`${styles.rosterCell} ${styles.rosterCellDone}`}>{p.done}</span>
                <span className={styles.rosterCell}>{p.pending}</span>
                <span className={`${styles.rosterCell} ${p.overdue > 0 ? styles.rosterCellOver : ''}`}>
                  {p.overdue}
                </span>
                <span className={styles.rosterCell}>{p.onTimePct !== null ? `${p.onTimePct}%` : '—'}</span>
                <span className={styles.rosterBar} aria-hidden>
                  <span className={styles.rosterBarFill} style={{ width: `${pct}%` }} />
                </span>
              </li>
            );
          })}
        </ul>
        <p className={styles.rosterFoot}>
          นับเป็น &quot;รายการที่รับผิดชอบ&quot; (งานแยกรายการนับทีละรายการ) · ไม่นับงานที่ยกเลิก ·
          ช่องว่างในคอลัมน์ตรงเวลาแปลว่ายังวัดไม่ได้ ไม่ได้แปลว่า 0%
        </p>
      </section>
    </>
  );
}
