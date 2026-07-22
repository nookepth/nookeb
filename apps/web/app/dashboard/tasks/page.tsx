'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import type { TaskDto, TaskItemDto, UserDto } from '@nookeb/shared';
import {
  ApiError,
  cancelTask,
  exportTasksXlsx,
  getMe,
  hasSession,
  listMyTasks,
  markTaskItemDone,
  updateTask,
} from '@/lib/api';
import { startLineLogin } from '@/lib/auth';
import { CloseIcon, ListIcon, SearchIcon, UserIcon } from '@/components/icons';
import TaskStatsCard from './TaskStatsCard';
import TaskActivitySummary from './TaskActivitySummary';
import TaskListItem, { type TaskQuickActions } from './TaskListItem';
import CreatePersonalTaskModal from './CreatePersonalTaskModal';
import UserPlanBadge from './UserPlanBadge';
import ProgressRing from './ProgressRing';
import FilterSortBar from './FilterSortBar';
import TodayFocusBanner from './TodayFocusBanner';
import TaskCalendar from './TaskCalendar';
import ActivityFeed from './ActivityFeed';
import PersonalStatsSection from './PersonalStatsSection';
import { effectiveDeadline, isOverdue, THAI_MONTHS } from './taskUtils';
import {
  applyFilter,
  applySort,
  computeStreak,
  focusTasks,
  loadCollapsed,
  loadFilterSort,
  loadPins,
  loadViewMode,
  monthProgress,
  pinnedFirst,
  saveCollapsed,
  saveFilterSort,
  savePins,
  saveViewMode,
  tasksOnDay,
  type TaskFilter,
  type TaskSort,
  type ViewMode,
} from './taskInsights';
import styles from './tasks.module.css';

type Tab = 'active' | 'overdue' | 'done' | 'cancelled';

const TAB_ORDER: Tab[] = ['active', 'overdue', 'done', 'cancelled'];

/* ---- small inline icons (brand rule: no emoji) ---- */

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
function CheckSmallIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function CoffeeIcon({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 9h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V9Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16M8 3.8c0 1-1 1.2-1 2.2M12 3.8c0 1-1 1.2-1 2.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
function TrophyIcon({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M8 4h8v5a4 4 0 0 1-8 0V4Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M8 5.5H5.5a0 0 0 0 0 0 0c0 2.5 1 4 2.8 4.4M16 5.5h2.5c0 2.5-1 4-2.8 4.4M12 13v3.5M8.5 20h7M10 16.5h4a1.5 1.5 0 0 1 1.5 1.5v2h-7v-2a1.5 1.5 0 0 1 1.5-1.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function FlagIcon({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 21V4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M6 4.5c2-1.3 4-1.3 6 0s4 1.3 6 0V13c-2 1.3-4 1.3-6 0s-4-1.3-6 0" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}
function ArchiveIcon({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5 9v9a1.8 1.8 0 0 0 1.8 1.8h10.4A1.8 1.8 0 0 0 19 18V9M10 13h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
function FlameIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 21c-3.6 0-6-2.3-6-5.6 0-2.4 1.5-4.2 2.7-5.8.9-1.2 1.8-2.4 1.8-3.8 0-.9-.2-1.6-.5-2.3 2.6.8 7 4 7 9.5 0 1-.3 2-.8 2.8-.3-.9-.9-1.7-1.7-2.2 0 2.7-.9 4.2-2.5 7.4Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function ListViewIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M8 6h12M8 12h12M8 18h12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="4" cy="6" r="1.3" fill="currentColor" />
      <circle cx="4" cy="12" r="1.3" fill="currentColor" />
      <circle cx="4" cy="18" r="1.3" fill="currentColor" />
    </svg>
  );
}
function CalViewIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="M3.5 9.5h17M8 2.8v4M16 2.8v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/* ---- per-tab empty states — part of the product, not an afterthought ---- */

const EMPTY_STATE: Record<Tab, { icon: (p: { size?: number }) => JSX.Element; title: string; body: string; cta?: boolean }> = {
  active: {
    icon: CoffeeIcon,
    title: 'ไม่มีงานค้างเลยน้า',
    body: 'ตอนนี้ว่างสุดๆ จะพักก่อนหรือสร้างงานใหม่ก็ได้เลย',
    cta: true,
  },
  overdue: {
    icon: TrophyIcon,
    title: 'ไม่มีงานเลยกำหนดเลย',
    body: 'ตามงานทันหมดทุกอัน เก่งมากน้า',
  },
  done: {
    icon: FlagIcon,
    title: 'ยังไม่มีงานที่เสร็จน้า',
    body: 'พอเสร็จงานแรกเมื่อไหร่ หนูจะจดไว้ตรงนี้ให้เลย',
  },
  cancelled: {
    icon: ArchiveIcon,
    title: 'ไม่มีงานที่ถูกยกเลิก',
    body: 'ยังไม่เคยยกเลิกงานเลย ถ้ามีหนูจะเก็บไว้ให้ดูย้อนหลังตรงนี้น้า',
  },
};

/** Time-of-day greeting (creative addition — the page should feel different at
 * 7 โมงเช้า vs เที่ยงคืน). */
function greeting(hour: number): string {
  if (hour < 5) return 'ดึกมากแล้วน้า';
  if (hour < 11) return 'อรุณสวัสดิ์น้า';
  if (hour < 16) return 'สวัสดีตอนบ่ายน้า';
  if (hour < 20) return 'สวัสดีตอนเย็นน้า';
  return 'ดึกแล้ว อย่าลืมพักน้า';
}

/** Motivational line — keyed off the VIEWER's own completions today. */
function motivationLine(activeCount: number, overdueCount: number, doneToday: number): string {
  if (doneToday >= 3) return `วันนี้เสร็จไปแล้ว ${doneToday} งาน สุดยอดไปเลยน้า`;
  if (doneToday > 0) return `วันนี้เสร็จไปแล้ว ${doneToday} งาน เก่งมากน้า`;
  if (overdueCount > 0) return `มีงานเลยกำหนด ${overdueCount} งาน ค่อยๆ เคลียร์ทีละงานน้า`;
  if (activeCount > 0) return `มีงานรออยู่ ${activeCount} งาน สู้ๆ น้า`;
  return 'วันนี้ไม่มีงานค้างเลย ชิลได้เต็มที่น้า';
}

/** Full-layout skeleton mirroring the real page — zero shift when data lands. */
function PageSkeleton() {
  return (
    <div aria-hidden>
      <div className={styles.skelProfile} />
      <div className={styles.statsGrid}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={styles.skelStat} />
        ))}
      </div>
      <div className={styles.skelActivity} />
      <div className={styles.list} style={{ marginTop: 14 }}>
        {[0, 1].map((i) => (
          <div key={i} className={styles.skeleton} />
        ))}
      </div>
    </div>
  );
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskDto[] | null>(null);
  const [viewerUid, setViewerUid] = useState<string>('');
  const [me, setMe] = useState<UserDto | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('active');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok?: boolean } | null>(null);
  const [exporting, setExporting] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // redesign state (prefs load client-side in an effect — avoids SSR mismatch)
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [sort, setSort] = useState<TaskSort>('deadline');
  const [view, setView] = useState<ViewMode>('list');
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [pins, setPins] = useState<string[]>([]);
  const [focusCollapsed, setFocusCollapsed] = useState(false);
  const [feedCollapsed, setFeedCollapsed] = useState(true);
  const [leavingIds, setLeavingIds] = useState<Set<string>>(new Set());
  const [postponeTask, setPostponeTask] = useState<TaskDto | null>(null);
  const [postponeValue, setPostponeValue] = useState('');
  const [postponeError, setPostponeError] = useState<string | null>(null);
  const [postponeBusy, setPostponeBusy] = useState(false);

  useEffect(() => {
    const fs = loadFilterSort();
    setFilter(fs.filter);
    setSort(fs.sort);
    setView(loadViewMode());
    setPins(loadPins());
    setFocusCollapsed(loadCollapsed('focus'));
    setFeedCollapsed(loadCollapsed('feed'));
  }, []);

  /**
   * Export every task the user can see — deliberately NOT the current
   * tab/filter selection. Those are browsing aids (scope chips, an "เกินกำหนด"
   * tab); a downloaded report that silently omitted rows because a chip was
   * active is the kind of thing people only notice after they've sent it on.
   */
  async function handleExport(): Promise<void> {
    if (exporting) return;
    setExporting(true);
    try {
      await exportTasksXlsx();
      showToast('ดาวน์โหลดไฟล์ Excel แล้วน้า', true);
    } catch (err) {
      showToast(
        err instanceof ApiError && err.status === 401
          ? 'เซสชันหมดอายุ ลองเข้าสู่ระบบใหม่น้า'
          : 'สร้างไฟล์ Excel ไม่สำเร็จ ลองใหม่อีกทีน้า',
      );
    } finally {
      setExporting(false);
    }
  }

  function showToast(msg: string, ok = false): void {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
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
      setLeavingIds(new Set());
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedsLogin(true);
      else setError('เช็คสัญญาณอินเทอร์เน็ตแล้วกดลองใหม่อีกทีน้า');
    }
  }, []);

  useEffect(() => {
    void load();
    // profile card is best-effort — the page works without it
    if (hasSession()) {
      getMe()
        .then(setMe)
        .catch(() => {})
        .finally(() => setMeLoaded(true));
    } else {
      setMeLoaded(true);
    }
  }, [load]);

  // desktop keyboard shortcuts: 1-4 switch tabs, / focuses search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key >= '1' && e.key <= '4') {
        const next = TAB_ORDER[Number(e.key) - 1];
        if (next) setTab(next);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ---- pref setters that also persist ---- */
  const changeFilter = (f: TaskFilter) => {
    setFilter(f);
    saveFilterSort(f, sort);
  };
  const changeSort = (s: TaskSort) => {
    setSort(s);
    saveFilterSort(filter, s);
  };
  const changeView = (v: ViewMode) => {
    setView(v);
    saveViewMode(v);
    if (v === 'list') setSelectedDay(null);
  };
  const toggleFocus = () => {
    setFocusCollapsed((c) => {
      saveCollapsed('focus', !c);
      return !c;
    });
  };
  const toggleFeed = () => {
    setFeedCollapsed((c) => {
      saveCollapsed('feed', !c);
      return !c;
    });
  };
  const togglePin = (taskId: string) => {
    setPins((prev) => {
      const next = prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [taskId, ...prev];
      savePins(next);
      return next;
    });
  };

  /* ---- actions ---- */

  async function handleDone(task: TaskDto, item: TaskItemDto): Promise<void> {
    setBusyId(item.id);
    try {
      await markTaskItemDone(task.id, item.id);
      showToast('เก่งมาก! บันทึกว่าเสร็จแล้วน้า', true);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedsLogin(true);
      else showToast('บันทึกไม่สำเร็จ ลองใหม่อีกครั้งน้า');
    } finally {
      setBusyId(null);
    }
  }

  /** Animate the card out, then refresh the list. */
  function leaveThenReload(taskId: string): void {
    setLeavingIds((prev) => new Set(prev).add(taskId));
    window.setTimeout(() => void load(), 260);
  }

  /** Quick action: mark ALL of the viewer's pending items on this task done. */
  async function handleCompleteTask(task: TaskDto): Promise<void> {
    const myPending = task.items.filter(
      (i) =>
        i.status !== 'done' &&
        i.status !== 'cancelled' &&
        i.assignees.some((a) => a.lineUid === viewerUid && !a.doneAt),
    );
    if (myPending.length === 0) return;
    setBusyId(task.id);
    try {
      let taskDone = false;
      for (const item of myPending) {
        const res = await markTaskItemDone(task.id, item.id);
        taskDone = res.taskDone;
      }
      showToast('เก่งมาก! บันทึกว่าเสร็จแล้วน้า', true);
      if (taskDone && (tab === 'active' || tab === 'overdue')) leaveThenReload(task.id);
      else await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedsLogin(true);
      else showToast('บันทึกไม่สำเร็จ ลองใหม่อีกครั้งน้า');
    } finally {
      setBusyId(null);
    }
  }

  /** Quick action: creator cancels the task (same confirm as the detail page). */
  async function handleCancelTask(task: TaskDto): Promise<void> {
    if (!window.confirm(`ยกเลิกงาน "${task.title}" ใช่ไหมน้า? หนูจะหยุดเตือนให้เลย`)) return;
    setBusyId(task.id);
    try {
      await cancelTask(task.id);
      showToast('ยกเลิกงานแล้วน้า', true);
      if (tab !== 'cancelled') leaveThenReload(task.id);
      else await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedsLogin(true);
      else showToast('ยกเลิกไม่สำเร็จ ลองใหม่อีกทีน้า');
    } finally {
      setBusyId(null);
    }
  }

  const openPostpone = (task: TaskDto) => {
    const base = task.globalDeadline ? new Date(task.globalDeadline) : new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    setPostponeValue(
      `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}T${pad(base.getHours())}:${pad(
        base.getMinutes(),
      )}`,
    );
    setPostponeError(null);
    setPostponeTask(task);
  };

  async function submitPostpone(): Promise<void> {
    if (!postponeTask || postponeBusy) return;
    const ms = new Date(postponeValue).getTime();
    if (!postponeValue || Number.isNaN(ms)) {
      setPostponeError('เลือกวันเวลาก่อนน้า');
      return;
    }
    if (ms <= Date.now()) {
      setPostponeError('กำหนดส่งใหม่ต้องอยู่ในอนาคตน้า');
      return;
    }
    setPostponeBusy(true);
    try {
      await updateTask(postponeTask.id, { globalDeadline: new Date(postponeValue).toISOString() });
      setPostponeTask(null);
      showToast('เลื่อนกำหนดส่งแล้วน้า', true);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setPostponeTask(null);
        setNeedsLogin(true);
      } else setPostponeError('เลื่อนไม่สำเร็จ ลองใหม่อีกทีน้า');
    } finally {
      setPostponeBusy(false);
    }
  }

  const retry = () => {
    setError(null);
    setTasks(null);
    void load();
  };

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
  const overdue = all.filter(isOverdue);
  const active = all.filter((t) => t.status !== 'done' && t.status !== 'cancelled' && !isOverdue(t));
  const finished = all.filter((t) => t.status === 'done');
  const cancelled = all.filter((t) => t.status === 'cancelled');
  const buckets: Record<Tab, TaskDto[]> = { active, overdue, done: finished, cancelled };

  // pipeline: tab bucket → scope filter → sort → pinned-first → search → (calendar day)
  const scoped = applyFilter(buckets[tab], filter, viewerUid);
  const sorted = pinnedFirst(applySort(scoped, sort), pins);
  const q = search.trim().toLowerCase();
  const matches = (t: TaskDto) =>
    !q || t.title.toLowerCase().includes(q) || t.items.some((i) => i.title.toLowerCase().includes(q));
  const searched = q ? sorted.filter(matches) : sorted;
  const dayFiltered = view === 'calendar' && selectedDay ? tasksOnDay(searched, selectedDay) : searched;
  const shownFiltered = dayFiltered;

  // viewer's own completions today (assignee doneAt), for the motivation line
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  let doneToday = 0;
  for (const t of all) {
    for (const item of t.items) {
      for (const a of item.assignees) {
        if (a.lineUid === viewerUid && a.doneAt && new Date(a.doneAt).getTime() >= todayStart.getTime()) {
          doneToday += 1;
        }
      }
    }
  }

  const streak = computeStreak(all, viewerUid);
  const ring = monthProgress(all);
  const focus = focusTasks(all);

  const TABS: { key: Tab; label: string; count: number; alert?: boolean }[] = [
    { key: 'active', label: 'กำลังทำ', count: applyFilter(active, filter, viewerUid).length },
    { key: 'overdue', label: 'เลยกำหนด', count: applyFilter(overdue, filter, viewerUid).length, alert: overdue.length > 0 },
    { key: 'done', label: 'เสร็จสิ้น', count: applyFilter(finished, filter, viewerUid).length },
    { key: 'cancelled', label: 'ยกเลิก', count: applyFilter(cancelled, filter, viewerUid).length },
  ];

  const empty = EMPTY_STATE[tab];
  const EmptyIcon = empty.icon;

  const quickActionsFor = (task: TaskDto): TaskQuickActions => {
    const live = task.status !== 'done' && task.status !== 'cancelled';
    const isCreator = task.createdByLineUid === viewerUid;
    const hasMyPending =
      live &&
      task.items.some(
        (i) =>
          i.status !== 'done' &&
          i.status !== 'cancelled' &&
          i.assignees.some((a) => a.lineUid === viewerUid && !a.doneAt),
      );
    return {
      onComplete: hasMyPending ? () => void handleCompleteTask(task) : undefined,
      onPostpone:
        live && isCreator && task.type !== 'recurring' ? () => openPostpone(task) : undefined,
      onCancel: live && isCreator ? () => void handleCancelTask(task) : undefined,
    };
  };

  // plain derivation (NOT a hook — this sits below the needsLogin early return)
  const selectedDayLabel = (() => {
    if (!selectedDay) return '';
    const d = new Date(`${selectedDay}T00:00:00`);
    return `${d.getDate()} ${THAI_MONTHS[d.getMonth()]}`;
  })();

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

      {/* error → designed card with retry */}
      {error && (
        <div className={styles.tdStateCard}>
          <div className={styles.tdStateIcon}>
            <AlertIcon size={26} />
          </div>
          <p className={styles.tdStateTitle}>โหลดงานไม่สำเร็จน้า</p>
          <p className={styles.tdStateText}>{error}</p>
          <button type="button" className={styles.tdRetryBtn} onClick={retry}>
            ลองใหม่อีกที
          </button>
        </div>
      )}

      {/* loading → full-layout skeleton (no blank flash, no shift) */}
      {!error && tasks === null && <PageSkeleton />}

      {!error && tasks !== null && (
        <>
          {/* A. hero: profile + streak + month progress ring */}
          {!meLoaded ? (
            <div className={styles.skelProfile} aria-hidden />
          ) : (
            <section className={styles.profileCard} aria-label="โปรไฟล์">
              {me?.pictureUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- LINE CDN avatar, remote domain varies
                <img className={styles.profileAvatar} src={me.pictureUrl} alt="" />
              ) : (
                <span className={`${styles.profileAvatar} ${styles.profileAvatarFallback}`}>
                  <UserIcon size={24} />
                </span>
              )}
              <div className={styles.profileInfo}>
                <span className={styles.profileNameRow}>
                  <span className={styles.profileName}>{me?.displayName || 'ผู้ใช้หนูเก็บ'}</span>
                  {me && <UserPlanBadge plan={me.plan} />}
                </span>
                <span className={styles.motivation}>
                  {greeting(new Date().getHours())} {motivationLine(active.length, overdue.length, doneToday)}
                </span>
                {streak > 0 && (
                  <span className={styles.streakChip} title="วันติดกันที่เสร็จงานตรงเวลาอย่างน้อย 1 งาน">
                    <FlameIcon /> {streak} วันติดต่อกัน
                  </span>
                )}
              </div>
              {ring.total > 0 && <ProgressRing done={ring.done} total={ring.total} />}
            </section>
          )}

          {all.length === 0 ? (
            /* first-run: one warm hero instead of a wall of zeroes */
            <div className={`${styles.emptyCard} ${styles.emptyHero}`}>
              <span className={styles.emptyIconWrap}>
                <ListIcon size={40} />
              </span>
              <h2 className={styles.emptyTitle}>ยังไม่มีงานเลยน้า</h2>
              <p className={styles.emptyBody}>
                สร้างงานส่วนตัวได้จากปุ่มด้านล่าง หรือกดปุ่ม &quot;สร้างงาน&quot; ในกลุ่ม LINE ของเธอ
                เดี๋ยวหนูช่วยตามให้เองน้า
              </p>
              <button type="button" className={styles.emptyCta} onClick={() => setCreateOpen(true)}>
                <PlusIcon size={16} /> สร้างงานส่วนตัว
              </button>
            </div>
          ) : (
            <>
              {/* B. today's focus banner (only when something is due/overdue) */}
              <TodayFocusBanner
                tasks={focus.due}
                overdueCount={focus.overdueCount}
                collapsed={focusCollapsed}
                onToggle={toggleFocus}
              />

              {/* C. KPI cards — clicking filters the list below */}
              <div className={styles.statsGrid}>
                <TaskStatsCard icon={<PlayIcon />} count={active.length} label="กำลังทำ" tone="progress" active={tab === 'active'} onClick={() => setTab('active')} />
                <TaskStatsCard icon={<AlertIcon />} count={overdue.length} label="เลยกำหนด" tone="overdue" active={tab === 'overdue'} onClick={() => setTab('overdue')} />
                <TaskStatsCard icon={<DoneIcon />} count={finished.length} label="เสร็จสิ้น" tone="done" active={tab === 'done'} onClick={() => setTab('done')} />
                <TaskStatsCard icon={<CancelIcon />} count={cancelled.length} label="ยกเลิก" tone="cancelled" active={tab === 'cancelled'} onClick={() => setTab('cancelled')} />
              </div>

              {/* D. activity summary + personal stats (client-side, no extra endpoint) */}
              <TaskActivitySummary tasks={all} />
              <PersonalStatsSection tasks={all} viewerUid={viewerUid} />

              {/* E. sticky search + view toggle + filter/sort + tabs */}
              <div className={styles.stickyBar}>
                <div className={styles.searchRow}>
                  <div className={styles.searchBar}>
                    <span className={styles.searchIcon}>
                      <SearchIcon size={16} />
                    </span>
                    <input
                      ref={searchRef}
                      className={styles.searchInput}
                      placeholder="ค้นหาชื่องาน..."
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      aria-label="ค้นหางาน"
                    />
                    {search && (
                      <button type="button" className={styles.searchClear} aria-label="ล้างคำค้น" onClick={() => setSearch('')}>
                        <CloseIcon size={14} />
                      </button>
                    )}
                  </div>
                  <div className={styles.viewToggle} role="group" aria-label="รูปแบบการแสดงผล">
                    <button
                      type="button"
                      className={`${styles.viewBtn} ${view === 'list' ? styles.viewBtnActive : ''}`}
                      aria-pressed={view === 'list'}
                      onClick={() => changeView('list')}
                    >
                      <ListViewIcon /> รายการ
                    </button>
                    <button
                      type="button"
                      className={`${styles.viewBtn} ${view === 'calendar' ? styles.viewBtnActive : ''}`}
                      aria-pressed={view === 'calendar'}
                      onClick={() => changeView('calendar')}
                    >
                      <CalViewIcon /> ปฏิทิน
                    </button>
                  </div>
                </div>
                <FilterSortBar
                  filter={filter}
                  sort={sort}
                  onFilter={changeFilter}
                  onSort={changeSort}
                  onExport={() => void handleExport()}
                  exporting={exporting}
                />
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
              </div>

              {/* F. calendar (toggle view) */}
              {view === 'calendar' && (
                <>
                  <TaskCalendar tasks={all} selected={selectedDay} onSelect={setSelectedDay} />
                  {selectedDay && (
                    <div className={styles.dayFilterChip}>
                      <span>แสดงงานวันที่ {selectedDayLabel}</span>
                      <button type="button" className={styles.dayFilterClear} aria-label="ล้างตัวกรองวัน" onClick={() => setSelectedDay(null)}>
                        <CloseIcon size={12} />
                      </button>
                    </div>
                  )}
                </>
              )}

              <div className={styles.listArea}>
                {shownFiltered.length > 0 ? (
                  <div className={styles.list} style={{ marginTop: 16 }}>
                    {shownFiltered.map((task) => (
                      <TaskListItem
                        key={task.id}
                        task={task}
                        viewerUid={viewerUid}
                        busyId={busyId}
                        onDone={(t, item) => void handleDone(t, item)}
                        pinned={pins.includes(task.id)}
                        onTogglePin={() => togglePin(task.id)}
                        actions={quickActionsFor(task)}
                        leaving={leavingIds.has(task.id)}
                      />
                    ))}
                  </div>
                ) : view === 'calendar' && selectedDay ? (
                  <div className={styles.emptyCard}>
                    <span className={styles.emptyIconWrap}>
                      <CalViewIcon size={30} />
                    </span>
                    <h2 className={styles.emptyTitle}>วันที่ {selectedDayLabel} ไม่มีงานครบกำหนดน้า</h2>
                    <p className={styles.emptyBody}>ลองแตะวันอื่นที่มีจุด หรือล้างตัวกรองวันดูน้า</p>
                    <button type="button" className={styles.emptyCta} onClick={() => setSelectedDay(null)}>
                      ล้างตัวกรองวัน
                    </button>
                  </div>
                ) : q ? (
                  <div className={styles.emptyCard}>
                    <span className={styles.emptyIconWrap}>
                      <SearchIcon size={30} />
                    </span>
                    <h2 className={styles.emptyTitle}>ไม่พบงานที่ตรงกับ &quot;{search.trim()}&quot;</h2>
                    <p className={styles.emptyBody}>ลองคำอื่น หรือสลับแท็บดูน้า</p>
                    <button type="button" className={styles.emptyCta} onClick={() => setSearch('')}>
                      ล้างคำค้น
                    </button>
                  </div>
                ) : filter !== 'all' && buckets[tab].length > 0 ? (
                  <div className={styles.emptyCard}>
                    <span className={styles.emptyIconWrap}>
                      <EmptyIcon size={34} />
                    </span>
                    <h2 className={styles.emptyTitle}>ไม่มีงานในตัวกรองนี้น้า</h2>
                    <p className={styles.emptyBody}>ลองเปลี่ยนตัวกรองเป็น &quot;ทั้งหมด&quot; ดูน้า</p>
                    <button type="button" className={styles.emptyCta} onClick={() => changeFilter('all')}>
                      ดูทั้งหมด
                    </button>
                  </div>
                ) : (
                  <div className={styles.emptyCard}>
                    <span className={styles.emptyIconWrap}>
                      <EmptyIcon size={34} />
                    </span>
                    <h2 className={styles.emptyTitle}>{empty.title}</h2>
                    <p className={styles.emptyBody}>{empty.body}</p>
                    {empty.cta && (
                      <button type="button" className={styles.emptyCta} onClick={() => setCreateOpen(true)}>
                        <PlusIcon size={16} /> สร้างงานส่วนตัว
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* G. activity feed */}
              <ActivityFeed tasks={all} collapsed={feedCollapsed} onToggle={toggleFeed} />
            </>
          )}
        </>
      )}

      {/* H. create personal task */}
      {!error && tasks !== null && (
        <button type="button" className={styles.fab} onClick={() => setCreateOpen(true)}>
          <PlusIcon /> สร้างงานส่วนตัว
        </button>
      )}
      {createOpen && (
        <CreatePersonalTaskModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            showToast('สร้างงานส่วนตัวแล้วน้า', true);
            void load();
          }}
          onUnauthorized={() => {
            setCreateOpen(false);
            setNeedsLogin(true);
          }}
        />
      )}

      {/* I. postpone-deadline modal (quick action) */}
      {postponeTask && (
        <div className={styles.modalOverlay} onClick={() => setPostponeTask(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2 className={styles.modalTitle}>เลื่อนกำหนดส่ง</h2>
            <p className={styles.hint} style={{ marginBottom: 12 }}>
              {postponeTask.title}
            </p>
            <label className={styles.fieldLabel}>กำหนดส่งใหม่</label>
            <div className={styles.tdDateInputWrap}>
              <input
                className={styles.input}
                type="datetime-local"
                style={{ border: 'none' }}
                value={postponeValue}
                onChange={(e) => setPostponeValue(e.target.value)}
              />
            </div>
            {postponeError && (
              <p className={styles.modalError} role="alert">
                {postponeError}
              </p>
            )}
            <div className={styles.modalActions}>
              <button type="button" className={styles.ghostBtn} onClick={() => setPostponeTask(null)} disabled={postponeBusy}>
                ยกเลิก
              </button>
              <button type="button" className={styles.primaryBtn} onClick={() => void submitPostpone()} disabled={postponeBusy}>
                {postponeBusy ? 'กำลังบันทึก...' : 'เลื่อนกำหนด'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`${styles.toast} ${toast.ok ? styles.toastOk : ''}`} role="status">
          {toast.ok && (
            <span className={styles.toastIcon}>
              <CheckSmallIcon />
            </span>
          )}
          {toast.msg}
        </div>
      )}
    </main>
  );
}
