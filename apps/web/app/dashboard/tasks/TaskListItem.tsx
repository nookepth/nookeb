'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { TaskDto, TaskItemDto, TaskStatus } from '@nookeb/shared';
import { ClockIcon } from '@/components/icons';
import { unnamedLabel } from './mascots';
import {
  effectiveDeadline,
  formatRelativeDeadline,
  isOverdue,
  taskProgress,
  urgency,
  URGENCY_META,
} from './taskUtils';
import styles from './tasks.module.css';

const TYPE_LABEL: Record<TaskDto['type'], string> = {
  single: 'งานเดียว',
  multi: 'แยกรายการ',
  recurring: 'งานประจำ',
};

const STATUS_BADGE: Record<TaskStatus, { label: string; bg: string; fg: string }> = {
  pending: { label: 'รอดำเนินการ', bg: '#f3f4f6', fg: '#374151' },
  in_progress: { label: 'กำลังทำ', bg: '#fef3c7', fg: '#b45309' },
  done: { label: 'เสร็จสิ้น', bg: '#d1fae5', fg: '#047857' },
  cancelled: { label: 'ยกเลิก', bg: '#fee2e2', fg: '#b91c1c' },
};

function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
      <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WarnIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3.5 21.5 20h-19L12 3.5Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M12 10v4.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="17.2" r="1.15" fill="currentColor" />
    </svg>
  );
}

function StarIcon({ size = 16, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} aria-hidden>
      <path
        d="m12 3.2 2.6 5.4 5.9.8-4.3 4.1 1.1 5.8-5.3-2.8-5.3 2.8 1.1-5.8L3.5 9.4l5.9-.8L12 3.2Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DotsIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.9" />
      <circle cx="12" cy="12" r="1.9" />
      <circle cx="19" cy="12" r="1.9" />
    </svg>
  );
}

export interface TaskQuickActions {
  /** viewer has a pending assignment → "ทำเสร็จแล้ว" */
  onComplete?: () => void;
  /** creator, live, non-recurring → "เลื่อน deadline" */
  onPostpone?: () => void;
  /** creator, live → "ยกเลิกงาน" */
  onCancel?: () => void;
}

/** One task card in the list: title, deadline, progress, items with the
 * viewer's เสร็จแล้ว button, group/personal badge, overdue warning, plus a
 * pin star and a quick-actions menu ("..." button or long-press). */
export default function TaskListItem({
  task,
  viewerUid,
  busyId,
  onDone,
  pinned,
  onTogglePin,
  actions,
  leaving,
}: {
  task: TaskDto;
  viewerUid: string;
  busyId: string | null;
  onDone: (task: TaskDto, item: TaskItemDto) => void;
  pinned: boolean;
  onTogglePin: () => void;
  actions: TaskQuickActions;
  leaving: boolean;
}) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);

  const { done, total } = taskProgress(task);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  /**
   * The date this card is actually judged by — the same one `isOverdue` uses.
   *
   * Reading `task.globalDeadline` here instead was a real contradiction on a
   * แยกรายการ task, which legitimately carries per-item deadlines and NO global
   * one: `isOverdue` (via `effectiveDeadline`) flagged the card red with a
   * warning triangle, while the deadline row below it — gated on the global
   * field — rendered nothing at all. The card asserted a problem and withheld
   * the date that made it one.
   */
  const deadline = effectiveDeadline(task);
  const u = urgency(deadline);
  const overdue = isOverdue(task);
  const isDone = task.status === 'done';
  const isCancelled = task.status === 'cancelled';
  const badge = STATUS_BADGE[task.status];

  const openDetail = () => router.push(`/dashboard/tasks/${task.id}`);

  const startLongPress = () => {
    longPressTimer.current = setTimeout(() => {
      suppressClick.current = true;
      setMenuOpen(true);
    }, 500);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  const menuItems: { label: string; danger?: boolean; run: () => void }[] = [
    { label: 'ดูรายละเอียด', run: openDetail },
  ];
  if (actions.onComplete) menuItems.push({ label: 'ทำเสร็จแล้ว', run: actions.onComplete });
  if (actions.onPostpone) menuItems.push({ label: 'เลื่อน deadline', run: actions.onPostpone });
  if (actions.onCancel) menuItems.push({ label: 'ยกเลิกงาน', danger: true, run: actions.onCancel });

  const renderItem = (item: TaskItemDto) => {
    const mine = item.assignees.find((a) => a.lineUid === viewerUid);
    const itemDone = item.status === 'done';
    /**
     * รอตรวจ / ตีกลับ (migration 045). These were invisible here: the row drew
     * done-vs-pending only, so an item that had been submitted and was sitting
     * on the creator's desk looked exactly like one nobody had started, and a
     * rejected item looked like ordinary outstanding work rather than something
     * bounced back. ติดตามสถานะ was built to surface this, but the task list is
     * where people actually work, so it has to be legible here too.
     *
     * `submitted` also suppresses the เสร็จแล้ว button below — self-marking an
     * item that is awaiting review is exactly the self-approval the ส่งงานกลับ
     * flow exists to prevent, and the API rejects it anyway.
     */
    const submitted = item.status === 'submitted';
    const rejected = item.status === 'rejected';
    const myPending =
      mine && !mine.doneAt && !itemDone && !submitted && item.status !== 'cancelled';
    // One fallback for a missing display_name across the whole dashboard: the
    // roster/mascots use unnamedLabel(), so a bare "สมาชิก" here rendered two
    // different names for the same person on two zones of the same page — and
    // collapsed two unnamed people into "สมาชิก, สมาชิก" on one row.
    const names = item.assignees.map((a) => a.displayName || unnamedLabel(a.lineUid)).join(', ');
    const dotClass = itemDone
      ? styles.itemDone
      : myPending || item.assignees.some((a) => !a.doneAt)
        ? styles.pending
        : '';
    return (
      <div key={item.id} className={`${styles.item} ${itemDone ? styles.itemDone : ''}`}>
        <span className={`${styles.itemDot} ${dotClass}`} />
        <div className={styles.itemMain}>
          <div className={`${styles.itemTitle} ${itemDone ? styles.struck : ''}`}>{item.title}</div>
          <div className={styles.itemMeta}>
            {names}
            {item.deadline ? ` · ${formatRelativeDeadline(item.deadline)}` : ''}
          </div>
        </div>
        {/* ตีกลับ is a LABEL, not a replacement for the action: the item is
            still live and its assignee can still close it from here, exactly as
            before. รอตรวจ below is the one state that does take the button
            away, because self-marking an item that is awaiting the creator's
            review is the self-approval the ส่งงานกลับ flow exists to prevent. */}
        {rejected && !itemDone && (
          <span className={`${styles.reviewChip} ${styles.reviewChipRejected}`} title="ถูกตีกลับ ต้องแก้แล้วส่งใหม่">
            ตีกลับ
          </span>
        )}
        {itemDone ? (
          <span className={styles.doneChip}>
            <CheckIcon /> เสร็จ
          </span>
        ) : submitted ? (
          <span className={`${styles.reviewChip} ${styles.reviewChipWaiting}`} title="ส่งงานกลับแล้ว รอคนสั่งงานกดรับงานหรือตีกลับ">
            รอตรวจ
          </span>
        ) : myPending ? (
          <button
            type="button"
            className={styles.doneBtn}
            disabled={busyId === item.id}
            onClick={(e) => {
              e.stopPropagation();
              onDone(task, item);
            }}
          >
            {busyId === item.id ? '...' : 'เสร็จแล้ว'}
          </button>
        ) : mine?.doneAt ? (
          <span className={styles.doneChip}>
            <CheckIcon /> เสร็จ
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <article
      className={`${styles.card} ${styles.cardLink} ${styles.cardIn} ${isDone ? styles.done : ''} ${
        isCancelled ? styles.cancelled : ''
      } ${overdue ? styles.cardOverdue : ''} ${pinned ? styles.cardPinned : ''} ${
        leaving ? styles.cardLeaving : ''
      }`}
      role="link"
      tabIndex={0}
      onClick={() => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        openDetail();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') openDetail();
      }}
      onTouchStart={startLongPress}
      onTouchEnd={cancelLongPress}
      onTouchMove={cancelLongPress}
    >
      <div className={styles.cardTop}>
        <h3 className={styles.cardTitle}>
          {overdue && (
            <span className={styles.warnIcon} aria-label="เลยกำหนด">
              <WarnIcon />
            </span>
          )}
          {task.title}
        </h3>
        <span className={styles.cardBadges}>
          {/* ความเร่งด่วน the creator picked (migration 050). Hidden once the
              task is closed — the priority of finished work is noise, and the
              row is already dimmed. Absent on chat-created tasks, which is a
              real state, so nothing is rendered rather than a fake "ปกติ". */}
          {task.urgency && !isDone && !isCancelled && (
            <span
              className={styles.urgencyBadge}
              style={{ color: URGENCY_META[task.urgency].fg, background: URGENCY_META[task.urgency].bg }}
              title={`ความเร่งด่วน: ${URGENCY_META[task.urgency].label}`}
            >
              {URGENCY_META[task.urgency].label}
            </span>
          )}
          <span className={task.isPersonal ? styles.scopePersonal : styles.scopeGroup}>
            {task.isPersonal ? 'ส่วนตัว' : 'กลุ่ม'}
          </span>
          <span className={styles.typeTag}>{TYPE_LABEL[task.type]}</span>
          <span className={styles.statusBadge} style={{ background: badge.bg, color: badge.fg }}>
            {badge.label}
          </span>
          <button
            type="button"
            className={`${styles.pinBtn} ${pinned ? styles.pinBtnOn : ''}`}
            aria-label={pinned ? 'เลิกปักหมุด' : 'ปักหมุดงานนี้'}
            aria-pressed={pinned}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
          >
            <StarIcon filled={pinned} />
          </button>
          <span className={styles.menuWrap}>
            <button
              type="button"
              className={styles.menuBtn}
              aria-label="ตัวเลือกงาน"
              aria-expanded={menuOpen}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((o) => !o);
              }}
            >
              <DotsIcon />
            </button>
            {menuOpen && (
              <>
                <span
                  className={styles.menuBackdrop}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                  }}
                />
                <span className={styles.menuPop} role="menu">
                  {menuItems.map((mi) => (
                    <button
                      key={mi.label}
                      type="button"
                      role="menuitem"
                      className={`${styles.menuItem} ${mi.danger ? styles.menuItemDanger : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpen(false);
                        mi.run();
                      }}
                    >
                      {mi.label}
                    </button>
                  ))}
                </span>
              </>
            )}
          </span>
        </span>
      </div>
      {deadline && (
        <span className={`${styles.deadline} ${u ? styles[u] : ''}`}>
          <ClockIcon size={14} />
          {u === 'overdue' ? 'เลยกำหนด ' : 'กำหนดส่ง '}
          {formatRelativeDeadline(deadline)}
          {/* On a แยกรายการ task this date is the EARLIEST item's, not one the
              whole task shares — say so, or the card reads as a single hard
              deadline that some of its own rows then appear to contradict. */}
          {!task.globalDeadline && <span className={styles.deadlineNote}>(รายการที่ใกล้ที่สุด)</span>}
        </span>
      )}
      <div className={styles.progressRow}>
        <div className={styles.progressTrack}>
          <div className={styles.progressFill} style={{ width: `${pct}%` }} />
        </div>
        <span className={styles.progressText}>
          {/* An empty track reading "0/0 เสร็จ" is indistinguishable from "0 of 1
              person finished", when the truth is that nobody is on this task
              yet — a different problem with a different fix. */}
          {total > 0 ? `${done}/${total} เสร็จ` : 'ยังไม่มีผู้รับผิดชอบ'}
        </span>
      </div>
      <div className={styles.items}>{task.items.map(renderItem)}</div>
    </article>
  );
}
