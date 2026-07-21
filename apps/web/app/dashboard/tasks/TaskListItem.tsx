'use client';

import { useRouter } from 'next/navigation';
import type { TaskDto, TaskItemDto, TaskStatus } from '@nookeb/shared';
import { ClockIcon } from '@/components/icons';
import { formatDeadline, isOverdue, taskProgress, urgency } from './taskUtils';
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

/** One task card in the list: title, deadline, progress, items with the
 * viewer's เสร็จแล้ว button, group/personal badge, overdue warning. Clicking
 * the card opens the detail page (same behaviour as the previous renderCard). */
export default function TaskListItem({
  task,
  viewerUid,
  busyId,
  onDone,
}: {
  task: TaskDto;
  viewerUid: string;
  busyId: string | null;
  onDone: (task: TaskDto, item: TaskItemDto) => void;
}) {
  const router = useRouter();
  const { done, total } = taskProgress(task);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const u = urgency(task.globalDeadline);
  const overdue = isOverdue(task);
  const isDone = task.status === 'done';
  const isCancelled = task.status === 'cancelled';
  const badge = STATUS_BADGE[task.status];

  const renderItem = (item: TaskItemDto) => {
    const mine = item.assignees.find((a) => a.lineUid === viewerUid);
    const itemDone = item.status === 'done';
    const myPending = mine && !mine.doneAt && !itemDone && item.status !== 'cancelled';
    const names = item.assignees.map((a) => a.displayName || 'สมาชิก').join(', ');
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
            {item.deadline ? ` · ${formatDeadline(item.deadline)}` : ''}
          </div>
        </div>
        {itemDone ? (
          <span className={styles.doneChip}>
            <CheckIcon /> เสร็จ
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
      className={`${styles.card} ${styles.cardLink} ${isDone ? styles.done : ''} ${
        isCancelled ? styles.cancelled : ''
      } ${overdue ? styles.cardOverdue : ''}`}
      role="link"
      tabIndex={0}
      onClick={() => router.push(`/dashboard/tasks/${task.id}`)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') router.push(`/dashboard/tasks/${task.id}`);
      }}
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
        <span style={{ display: 'inline-flex', gap: 6, flex: '0 0 auto', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span className={task.isPersonal ? styles.scopePersonal : styles.scopeGroup}>
            {task.isPersonal ? 'ส่วนตัว' : 'กลุ่ม'}
          </span>
          <span className={styles.typeTag}>{TYPE_LABEL[task.type]}</span>
          <span className={styles.statusBadge} style={{ background: badge.bg, color: badge.fg }}>
            {badge.label}
          </span>
        </span>
      </div>
      {task.globalDeadline && (
        <span className={`${styles.deadline} ${u ? styles[u] : ''}`}>
          <ClockIcon size={14} />
          {u === 'overdue' ? 'เลยกำหนด ' : 'กำหนดส่ง '}
          {formatDeadline(task.globalDeadline)}
        </span>
      )}
      <div className={styles.progressRow}>
        <div className={styles.progressTrack}>
          <div className={styles.progressFill} style={{ width: `${pct}%` }} />
        </div>
        <span className={styles.progressText}>
          {done}/{total} เสร็จ
        </span>
      </div>
      <div className={styles.items}>{task.items.map(renderItem)}</div>
    </article>
  );
}
