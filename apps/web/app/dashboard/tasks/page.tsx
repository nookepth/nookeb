'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import type { TaskDto, TaskItemDto, UserDto } from '@nookeb/shared';
import { ApiError, getMe, hasSession, listMyTasks, markTaskItemDone } from '@/lib/api';
import { startLineLogin } from '@/lib/auth';
import { ListIcon, UserIcon } from '@/components/icons';
import TaskStatsCard from './TaskStatsCard';
import TaskActivitySummary from './TaskActivitySummary';
import TaskListItem from './TaskListItem';
import CreatePersonalTaskModal from './CreatePersonalTaskModal';
import UserPlanBadge from './UserPlanBadge';
import { effectiveDeadline, isOverdue } from './taskUtils';
import styles from './tasks.module.css';

type Tab = 'active' | 'overdue' | 'done' | 'cancelled';

const TAB_EMPTY: Record<Tab, string> = {
  active: 'ยังไม่มีงานที่กำลังทำน้า',
  overdue: 'ไม่มีงานเลยกำหนด เก่งมากน้า',
  done: 'ยังไม่มีงานที่เสร็จน้า',
  cancelled: 'ยังไม่มีงานที่ถูกยกเลิกน้า',
};

/* ---- small inline icons for the KPI cards (brand rule: no emoji) ---- */

function PlayIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7.5v4.5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function AlertIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 3.5 21.5 20h-19L12 3.5Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M12 10v4.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="17.2" r="1.15" fill="currentColor" />
    </svg>
  );
}
function DoneIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="2" />
      <path d="m8.5 12.2 2.4 2.4 4.6-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function CancelIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="2" />
      <path d="m9 9 6 6M15 9l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function PlusIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** Sort helper: deadline ASC with null deadlines last. */
function byDeadlineAsc(a: TaskDto, b: TaskDto): number {
  const da = effectiveDeadline(a);
  const db = effectiveDeadline(b);
  if (da === null && db === null) return 0;
  if (da === null) return 1;
  if (db === null) return -1;
  return da < db ? -1 : da > db ? 1 : 0;
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskDto[] | null>(null);
  const [viewerUid, setViewerUid] = useState<string>('');
  const [me, setMe] = useState<UserDto | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('active');
  const [createOpen, setCreateOpen] = useState(false);
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
    // profile card is best-effort — the page works without it
    if (hasSession()) {
      getMe()
        .then(setMe)
        .catch(() => {});
    }
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

  const all = tasks ?? [];
  // เลยกำหนด is its own bucket — กำลังทำ shows only live tasks NOT past deadline
  const overdue = all.filter(isOverdue).sort(byDeadlineAsc); // oldest deadline = most overdue first
  const active = all
    .filter((t) => t.status !== 'done' && t.status !== 'cancelled' && !isOverdue(t))
    .sort(byDeadlineAsc);
  const finished = all.filter((t) => t.status === 'done').sort(byDeadlineAsc);
  const cancelled = all.filter((t) => t.status === 'cancelled').sort(byDeadlineAsc);
  const shown =
    tab === 'active' ? active : tab === 'overdue' ? overdue : tab === 'done' ? finished : cancelled;

  const TABS: { key: Tab; label: string; count: number; alert?: boolean }[] = [
    { key: 'active', label: 'กำลังทำ', count: active.length },
    { key: 'overdue', label: 'เลยกำหนด', count: overdue.length, alert: overdue.length > 0 },
    { key: 'done', label: 'เสร็จสิ้น', count: finished.length },
    { key: 'cancelled', label: 'ยกเลิก', count: cancelled.length },
  ];

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

      {/* A. profile card */}
      {me && (
        <section className={styles.profileCard} aria-label="โปรไฟล์">
          {me.pictureUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- LINE CDN avatar, remote domain varies
            <img className={styles.profileAvatar} src={me.pictureUrl} alt="" />
          ) : (
            <span className={`${styles.profileAvatar} ${styles.profileAvatarFallback}`}>
              <UserIcon size={24} />
            </span>
          )}
          <div className={styles.profileInfo}>
            <span className={styles.profileName}>{me.displayName || 'ผู้ใช้หนูเก็บ'}</span>
            <UserPlanBadge plan={me.plan} />
          </div>
        </section>
      )}

      {error && <p className={styles.error}>{error}</p>}

      {!error && tasks === null && (
        <div className={styles.list}>
          {[0, 1, 2].map((i) => (
            <div key={i} className={styles.skeleton} />
          ))}
        </div>
      )}

      {!error && tasks !== null && (
        <>
          {/* B. KPI cards — clicking filters the list below */}
          <div className={styles.statsGrid}>
            <TaskStatsCard
              icon={<PlayIcon />}
              count={active.length}
              label="กำลังทำ"
              tone="progress"
              active={tab === 'active'}
              onClick={() => setTab('active')}
            />
            <TaskStatsCard
              icon={<AlertIcon />}
              count={overdue.length}
              label="เลยกำหนด"
              tone="overdue"
              active={tab === 'overdue'}
              onClick={() => setTab('overdue')}
            />
            <TaskStatsCard
              icon={<DoneIcon />}
              count={finished.length}
              label="เสร็จสิ้น"
              tone="done"
              active={tab === 'done'}
              onClick={() => setTab('done')}
            />
            <TaskStatsCard
              icon={<CancelIcon />}
              count={cancelled.length}
              label="ยกเลิก"
              tone="cancelled"
              active={tab === 'cancelled'}
              onClick={() => setTab('cancelled')}
            />
          </div>

          {/* C. activity summary (client-side, no extra endpoint) */}
          <TaskActivitySummary tasks={all} />

          {/* D. tabbed task list */}
          {all.length === 0 ? (
            <div className={styles.empty}>
              <span className={styles.emptyIcon}>
                <ListIcon size={56} />
              </span>
              <h2>ยังไม่มีงานเลยน้า</h2>
              <p>สร้างงานส่วนตัวได้จากปุ่มด้านล่าง หรือกดปุ่ม &quot;สร้างงาน&quot; ในกลุ่ม LINE ของเธอ</p>
            </div>
          ) : (
            <>
              <div className={styles.tabs} role="tablist">
                {TABS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.key}
                    className={`${styles.tab} ${tab === t.key ? styles.tabActive : ''} ${
                      t.alert ? styles.tabAlert : ''
                    }`}
                    onClick={() => setTab(t.key)}
                  >
                    {t.label} ({t.count})
                  </button>
                ))}
              </div>
              {shown.length > 0 ? (
                <div className={styles.list} style={{ marginTop: 16 }}>
                  {shown.map((task) => (
                    <TaskListItem
                      key={task.id}
                      task={task}
                      viewerUid={viewerUid}
                      busyId={busyId}
                      onDone={(t, item) => void handleDone(t, item)}
                    />
                  ))}
                </div>
              ) : (
                <p className={styles.hint} style={{ marginTop: 24, textAlign: 'center' }}>
                  {TAB_EMPTY[tab]}
                </p>
              )}
            </>
          )}
        </>
      )}

      {/* E. create personal task */}
      {!needsLogin && !error && tasks !== null && (
        <button type="button" className={styles.fab} onClick={() => setCreateOpen(true)}>
          <PlusIcon /> สร้างงานส่วนตัว
        </button>
      )}
      {createOpen && (
        <CreatePersonalTaskModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            showToast('สร้างงานส่วนตัวแล้วน้า');
            void load();
          }}
          onUnauthorized={() => {
            setCreateOpen(false);
            setNeedsLogin(true);
          }}
        />
      )}

      {toast && (
        <div className={styles.toast} role="status">
          {toast}
        </div>
      )}
    </main>
  );
}
