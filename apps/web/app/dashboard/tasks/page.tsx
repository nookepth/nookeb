'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import type { TaskDto, TaskItemDto } from '@nookeb/shared';
import { ApiError, hasSession, listMyTasks, markTaskItemDone } from '@/lib/api';
import { startLineLogin } from '@/lib/auth';
import { ClockIcon, ListIcon } from '@/components/icons';
import styles from './tasks.module.css';

const TYPE_LABEL: Record<TaskDto['type'], string> = {
  single: 'งานเดียว',
  multi: 'แยกรายการ',
  recurring: 'งานประจำ',
};

const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

function formatDeadline(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

/** '' = normal, 'urgent' ≤ 24h left, 'overdue' past. */
function urgency(iso: string | null): '' | 'urgent' | 'overdue' {
  if (!iso) return '';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return 'overdue';
  if (diff <= 24 * 60 * 60 * 1000) return 'urgent';
  return '';
}

function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
      <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Progress: done assignee-slots / total assignee-slots across live items. */
function taskProgress(task: TaskDto): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const item of task.items) {
    if (item.status === 'cancelled') continue;
    for (const a of item.assignees) {
      total += 1;
      if (a.doneAt) done += 1;
    }
  }
  return { done, total };
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskDto[] | null>(null);
  const [viewerUid, setViewerUid] = useState<string>('');
  const [needsLogin, setNeedsLogin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string): void {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }

  const load = useCallback(async () => {
    if (!hasSession()) {
      setNeedsLogin(true);
      return;
    }
    try {
      const res = await listMyTasks();
      setTasks(res.tasks);
      setViewerUid(res.viewerLineUid);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedsLogin(true);
      else setError('โหลดงานไม่สำเร็จ ลองรีเฟรชอีกครั้งน้า');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleDone(task: TaskDto, item: TaskItemDto): Promise<void> {
    setBusyId(item.id);
    try {
      await markTaskItemDone(task.id, item.id);
      showToast('บันทึกว่าเสร็จแล้วน้า');
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedsLogin(true);
      else showToast('บันทึกไม่สำเร็จ ลองใหม่อีกครั้งน้า');
    } finally {
      setBusyId(null);
    }
  }

  if (needsLogin) {
    return (
      <div className="center-page">
        <Image src="/logo.png" alt="หนูเก็บ" width={120} height={120} className="login-logo" priority />
        <h1>หนูเก็บ</h1>
        <p>เข้าสู่ระบบด้วย LINE เพื่อดูงานของคุณ</p>
        <button className="btn" onClick={startLineLogin}>
          เข้าสู่ระบบด้วย LINE
        </button>
      </div>
    );
  }

  const active = (tasks ?? []).filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  const finished = (tasks ?? []).filter((t) => t.status === 'done');

  const renderItem = (task: TaskDto, item: TaskItemDto) => {
    const mine = item.assignees.find((a) => a.lineUid === viewerUid);
    const itemDone = item.status === 'done';
    const myPending = mine && !mine.doneAt && !itemDone && item.status !== 'cancelled';
    const names = item.assignees.map((a) => a.displayName || 'สมาชิก').join(', ');
    const dotClass = itemDone ? styles.itemDone : myPending || item.assignees.some((a) => !a.doneAt) ? styles.pending : '';
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
            onClick={() => void handleDone(task, item)}
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

  const renderCard = (task: TaskDto) => {
    const { done, total } = taskProgress(task);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const u = urgency(task.globalDeadline);
    const isDone = task.status === 'done';
    return (
      <article key={task.id} className={`${styles.card} ${isDone ? styles.done : ''}`}>
        <div className={styles.cardTop}>
          <h3 className={styles.cardTitle}>{task.title}</h3>
          <span className={styles.typeTag}>{TYPE_LABEL[task.type]}</span>
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
        <div className={styles.items}>{task.items.map((item) => renderItem(task, item))}</div>
      </article>
    );
  };

  return (
    <main className={styles.wrap}>
      <a className={styles.back} href="/dashboard">
        ← กลับคลัง
      </a>
      <h1 className={styles.title}>
        <span className={styles.titleIcon}>
          <ListIcon size={24} />
        </span>
        งานของฉัน
      </h1>
      <p className={styles.hint}>งานที่เธอสร้างหรือถูกมอบหมายจากทุกกลุ่ม หนูรวมมาไว้ที่เดียวให้แล้วน้า</p>

      {error && <p className={styles.error}>{error}</p>}

      {!error && tasks === null && (
        <div className={styles.list}>
          {[0, 1, 2].map((i) => (
            <div key={i} className={styles.skeleton} />
          ))}
        </div>
      )}

      {!error && tasks !== null && tasks.length === 0 && (
        <div className={styles.empty}>
          <span className={styles.emptyIcon}>
            <ListIcon size={56} />
          </span>
          <h2>ยังไม่มีงานเลยน้า</h2>
          <p>สร้างงานได้จากปุ่ม &quot;สร้างงาน&quot; ในกลุ่ม LINE ของเธอ</p>
        </div>
      )}

      {!error && tasks !== null && tasks.length > 0 && (
        <>
          {active.length > 0 && (
            <>
              <p className={styles.sectionLabel}>กำลังทำ ({active.length})</p>
              <div className={styles.list}>{active.map(renderCard)}</div>
            </>
          )}
          {finished.length > 0 && (
            <>
              <p className={styles.sectionLabel}>เสร็จแล้ว ({finished.length})</p>
              <div className={styles.list}>{finished.map(renderCard)}</div>
            </>
          )}
        </>
      )}

      {toast && (
        <div className={styles.toast} role="status">
          {toast}
        </div>
      )}
    </main>
  );
}
