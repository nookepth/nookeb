'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import type { TaskDto, TaskItemDto, TaskItemStatus } from '@nookeb/shared';
import { formatRelativeDeadline, isOverdue } from './taskUtils';
import styles from './tasks.module.css';

/**
 * The pipeline stages, in the order work actually moves through them. This is
 * the same ladder the Google Sheets workspace paints (ความคืบหน้า /
 * STAGE_PROGRESS) — kept in the same order here so the two never disagree about
 * what "ก่อนหน้า" means.
 *
 * `submitted` and `rejected` (migration 045) are the reason this section
 * exists: both are already in the DTO and both are invisible on the task list,
 * which only ever draws done vs pending. A submission sitting unreviewed for
 * three days looked exactly like a task nobody had started.
 */
const STAGES: { key: TaskItemStatus; label: string; tone: string; note: string }[] = [
  { key: 'pending', label: 'รอดำเนินการ', tone: 'stagePending', note: 'ยังไม่มีใครกดรับทราบ' },
  { key: 'in_progress', label: 'กำลังทำ', tone: 'stageProgress', note: 'รับทราบแล้ว กำลังทำอยู่' },
  { key: 'submitted', label: 'รอตรวจ', tone: 'stageReview', note: 'ส่งงานกลับแล้ว รอคนสั่งงานรับ' },
  { key: 'rejected', label: 'ตีกลับ', tone: 'stageRejected', note: 'ถูกตีกลับ ต้องแก้แล้วส่งใหม่' },
  { key: 'done', label: 'เสร็จแล้ว', tone: 'stageDone', note: 'ปิดงานเรียบร้อย' },
  { key: 'cancelled', label: 'ยกเลิก', tone: 'stageCancelled', note: 'ยกเลิกไปแล้ว ไม่นับในสถิติ' },
];

interface Slot {
  task: TaskDto;
  item: TaskItemDto;
  /** the viewer is an assignee on this item */
  mine: boolean;
  /** the viewer created the task, so a รอตรวจ item is waiting on THEM */
  waitingOnMe: boolean;
}

function ChevronRightIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="m9 5 7 7-7 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * ติดตามสถานะ — every task ITEM grouped by the stage it is parked at, so a
 * glance answers "where is work stuck?" rather than "how many tasks exist".
 * Derived entirely from the loaded payload; no extra endpoint.
 */
export default function StatusTrackingSection({
  tasks,
  viewerUid,
}: {
  tasks: TaskDto[];
  viewerUid: string;
}) {
  const router = useRouter();

  const { byStage, total, waitingOnMe } = useMemo(() => {
    const byStage = new Map<TaskItemStatus, Slot[]>();
    for (const s of STAGES) byStage.set(s.key, []);
    let total = 0;
    let waitingOnMe = 0;
    for (const task of tasks) {
      const isCreator = task.createdByLineUid === viewerUid;
      for (const item of task.items) {
        // A cancelled TASK parks every one of its items in ยกเลิก, whatever the
        // item row still says — the item statuses are not rewritten on cancel.
        const stage: TaskItemStatus = task.status === 'cancelled' ? 'cancelled' : item.status;
        const bucket = byStage.get(stage);
        if (!bucket) continue;
        const mine = item.assignees.some((a) => a.lineUid === viewerUid);
        const onMe = stage === 'submitted' && isCreator;
        if (onMe) waitingOnMe += 1;
        bucket.push({ task, item, mine, waitingOnMe: onMe });
        total += 1;
      }
    }
    // inside a lane: the viewer's own work first, then nearest deadline
    for (const list of byStage.values()) {
      list.sort((a, b) => {
        if (a.waitingOnMe !== b.waitingOnMe) return a.waitingOnMe ? -1 : 1;
        if (a.mine !== b.mine) return a.mine ? -1 : 1;
        const da = a.item.deadline ?? '';
        const db = b.item.deadline ?? '';
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return da < db ? -1 : 1;
      });
    }
    return { byStage, total, waitingOnMe };
  }, [tasks, viewerUid]);

  if (total === 0) {
    return (
      <div className={styles.emptyCard}>
        <h2 className={styles.emptyTitle}>ยังไม่มีรายการงานให้ติดตามน้า</h2>
        <p className={styles.emptyBody}>พอมีงานเข้ามา หนูจะแยกให้เห็นเลยว่าค้างอยู่ขั้นไหน</p>
      </div>
    );
  }

  return (
    <>
      {waitingOnMe > 0 && (
        <div className={styles.reviewCallout} role="status">
          <span className={styles.reviewCalloutNum}>{waitingOnMe}</span>
          <span>
            <strong>มีงานส่งกลับมารอเธอตรวจ</strong>
            <br />
            เปิดงานแล้วกด &quot;รับงาน&quot; หรือ &quot;ตีกลับ&quot; ให้เขาได้เลยน้า
          </span>
        </div>
      )}

      <div className={styles.stageGrid}>
        {STAGES.map((stage) => {
          const list = byStage.get(stage.key) ?? [];
          const pct = total > 0 ? Math.round((list.length / total) * 100) : 0;
          return (
            <section key={stage.key} className={styles.stageCard} aria-label={stage.label}>
              <header className={styles.stageHead}>
                <span className={`${styles.stagePip} ${styles[stage.tone]}`} />
                <span className={styles.stageLabel}>{stage.label}</span>
                <span className={styles.stageCount}>{list.length}</span>
              </header>
              <p className={styles.stageNote}>{stage.note}</p>
              <div className={styles.stageTrack}>
                <span className={`${styles.stageFill} ${styles[stage.tone]}`} style={{ width: `${pct}%` }} />
              </div>
              {list.length === 0 ? (
                <p className={styles.stageEmpty}>ไม่มีงานในขั้นนี้</p>
              ) : (
                <ul className={styles.stageList}>
                  {list.slice(0, 6).map((s) => {
                    const over = isOverdue(s.task) && stage.key !== 'done' && stage.key !== 'cancelled';
                    return (
                      <li key={`${s.task.id}-${s.item.id}`}>
                        <button
                          type="button"
                          className={`${styles.stageItem} ${s.waitingOnMe ? styles.stageItemMine : ''}`}
                          onClick={() => router.push(`/dashboard/tasks/${s.task.id}`)}
                        >
                          <span className={styles.stageItemMain}>
                            <span className={styles.stageItemTitle}>{s.item.title || s.task.title}</span>
                            <span className={styles.stageItemMeta}>
                              {s.task.isPersonal ? 'งานส่วนตัว' : 'งานกลุ่ม'}
                              {s.item.deadline ? ` · ${formatRelativeDeadline(s.item.deadline)}` : ''}
                              {s.mine ? ' · ของฉัน' : ''}
                            </span>
                          </span>
                          {over && <span className={styles.stageItemFlag}>เลยกำหนด</span>}
                          <span className={styles.stageItemChev}>
                            <ChevronRightIcon />
                          </span>
                        </button>
                      </li>
                    );
                  })}
                  {list.length > 6 && (
                    <li className={styles.stageMore}>และอีก {list.length - 6} รายการ</li>
                  )}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
