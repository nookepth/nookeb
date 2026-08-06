'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import type { TaskDto, TaskItemDto, UserDto } from '@nookeb/shared';
import {
  ApiError,
  cancelTask,
  getMe,
  hasSession,
  listMyTasks,
  markTaskItemDone,
  updateTask,
} from '@/lib/api';
import { startLineLogin } from '@/lib/auth';
import { PLAN_DISPLAY_NAME } from '@/lib/quota-errors';
import { CloseIcon, ListIcon, SearchIcon, UserIcon } from '@/components/icons';
import TaskStatsCard from './TaskStatsCard';
import TaskActivitySummary from './TaskActivitySummary';
import TaskListItem, { type TaskQuickActions } from './TaskListItem';
import CreatePersonalTaskModal from './CreatePersonalTaskModal';
import { QuotaExceededModal, UpgradeModal } from '@/components/UpgradeModal';
import UserPlanBadge from './UserPlanBadge';
import ProgressRing from './ProgressRing';
import FilterSortBar from './FilterSortBar';
import TodayFocusBanner from './TodayFocusBanner';
import TaskCalendar from './TaskCalendar';
import ActivityFeed from './ActivityFeed';
import PersonalStatsSection from './PersonalStatsSection';
import SectionNav, { SECTION_HINT, SECTION_LABEL, type Section } from './SectionNav';
import StatusTrackingSection from './StatusTrackingSection';
import TeamReportSection from './TeamReportSection';
import WeeklyTrendChart from './WeeklyTrendChart';
import HowToSection from './HowToSection';
import MascotLayer from './MascotLayer';
import { rosterStats } from './mascots';
import { effectiveDeadline, isOverdue, THAI_MONTHS } from './taskUtils';
import {
  applyFilter,
  applySort,
  computeStreak,
  DUE_GROUP_LABEL,
  groupByDue,
  focusTasks,
  loadCollapsed,
  loadFilterSort,
  loadPins,
  loadSection,
  loadViewMode,
  overallProgress,
  pinnedFirst,
  saveCollapsed,
  saveFilterSort,
  savePins,
  saveSection,
  saveViewMode,
  tasksOnDay,
  timeAgo,
  type TaskFilter,
  type TaskSort,
  type ViewMode,
} from './taskInsights';
import styles from './tasks.module.css';

type Tab = 'active' | 'overdue' | 'done' | 'cancelled';

const TAB_ORDER: Tab[] = ['active', 'overdue', 'done', 'cancelled'];

/**
 * What Export Excel actually buys — concrete, not "unlock premium features".
 * Lives here rather than in the shared modal: the checklist is about THIS
 * feature, and the component is meant to stay feature-agnostic.
 */
const EXPORT_PERKS = [
  'ดาวน์โหลดงานทั้งหมดเป็นไฟล์ .xlsx แถวละรายการ',
  'มีวันครบกำหนด ผู้รับผิดชอบ และสถานะครบทุกคอลัมน์',
  'เชื่อม Google Sheets ให้อัปเดตเองอัตโนมัติ',
];

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
function RefreshIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M20 11.5a8 8 0 1 1-2.6-5.4"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path d="M20.5 3v4.2h-4.2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
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
  /** GET /auth/me failed — the page degrades on purpose but says so. */
  const [profileFailed, setProfileFailed] = useState(false);
  /** Pre-cap task count from the API; null = the API didn't say (old build). */
  const [totalTasks, setTotalTasks] = useState<number | null>(null);
  /**
   * When the current payload landed. A tracking dashboard is a page people
   * leave open — LINE keeps changing the data behind it while the tab sits
   * there, so the page has to say how old what you're reading is, and let you
   * refresh without losing your zone, filters and scroll to a full reload.
   */
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** Re-renders the "อัปเดตเมื่อ …" stamp as it ages. */
  const [, setNowTick] = useState(0);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('active');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok?: boolean } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  /** Set when POST /tasks answers 429 — carries the server's own reset instant. */
  const [quotaGate, setQuotaGate] = useState<{ feature: string; resetAt?: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  /** see the assignment below `changeSection` */
  const gotoMineRef = useRef<() => void>(() => {});
  /** "/" was pressed from another zone — focus the search box once it mounts */
  const [wantSearchFocus, setWantSearchFocus] = useState(false);

  // redesign state (prefs load client-side in an effect — avoids SSR mismatch)
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [sort, setSort] = useState<TaskSort>('deadline');
  /**
   * The page zone. Each one is a focused data set — the four STATUS tabs
   * (กำลังทำ / เลยกำหนด / เสร็จสิ้น / ยกเลิก) live inside `mine` and are a
   * different axis entirely; keeping them in the same row was what made the old
   * single-column layout hard to scan.
   */
  const [section, setSection] = useState<Section>('overview');
  /** set when a floating mascot is clicked — scrolls รายงานทีม to that person */
  const [highlightUid, setHighlightUid] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [pins, setPins] = useState<string[]>([]);
  /**
   * The ปฏิทิน day-list header. On a phone the month grid fills most of the
   * viewport, so tapping a day updates a list that is entirely below the fold
   * and the tap reads as if it did nothing — the whole point of the phone
   * calendar is that the titles live down there. Scrolled into view by the
   * effect below; `scroll-margin-top` in the stylesheet keeps it clear of the
   * sticky zone nav.
   */
  const calListHeadRef = useRef<HTMLDivElement | null>(null);
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
    setPins(loadPins());
    setFocusCollapsed(loadCollapsed('focus'));
    setFeedCollapsed(loadCollapsed('feed'));
    // Zone restore. The old list/calendar toggle is now the ปฏิทิน zone, so a
    // returning visitor whose last saved VIEW was calendar lands there — the
    // preference survives the restructure rather than being silently dropped.
    const saved = loadSection();
    if (saved && (SECTION_LABEL as Record<string, string>)[saved]) setSection(saved as Section);
    else if (loadViewMode() === 'calendar') setSection('calendar');
  }, []);

  /**
   * Is Export behind the plan gate for this viewer? Mirrors
   * FEATURE_ACCESS.export_task_summary in apps/api/src/config/plans.ts (free
   * false, pro/premium true) — expressed as "free is locked" rather than a list
   * of allowed tiers, so a future tier is never accidentally locked out.
   * Undefined `me` (profile fetch failed) reads as unlocked; see handleExport.
   */
  const exportLocked = me?.plan === 'free';

  /**
   * Export every task the user can see — deliberately NOT the current
   * tab/filter selection. Those are browsing aids (scope chips, an "เกินกำหนด"
   * tab); a downloaded report that silently omitted rows because a chip was
   * active is the kind of thing people only notice after they've sent it on.
   */
  async function handleExport(): Promise<void> {
    if (exporting) return;
    // §14 — Export is Pro and above. The server gate (planGuard) is the real
    // boundary and stays untouched, but it can only answer 403 JSON — and the
    // download below is a TOP-LEVEL navigation, so that JSON would replace the
    // whole page with `{"error":"PLAN_UPGRADE_REQUIRED"}` on white. So a free
    // user never starts the navigation: they get the upgrade modal instead.
    // `me` is best-effort (see the load effect); if it never arrived we let the
    // navigation happen rather than block a paying user on a missing profile.
    if (exportLocked) {
      setUpgradeOpen(true);
      return;
    }
    setExporting(true);
    try {
      // Auth is the HttpOnly session cookie (app-signed JWT) — client JS cannot
      // read it, and there is no Bearer token to append. So a top-level
      // navigation to the same-origin export endpoint is the ONLY path that
      // stays authenticated: it carries the cookie, and the API's
      // Content-Disposition: attachment triggers a download instead of a page
      // change. This works identically in the LINE in-app browser (same-origin,
      // shares the cookie) and in normal browsers. Do NOT use
      // liff.openWindow({ external: true }) — the external browser is a separate
      // cookie jar and would 401. Deliberately param-free: export EVERYTHING,
      // never the active tab/filter.
      window.location.href = `${window.location.origin}/api-proxy/tasks/export`;
      // An attachment download does NOT unload this page, so there is no event
      // to await — clear the loading state after a short beat for feedback.
      setTimeout(() => setExporting(false), 1500);
    } catch (err) {
      console.error(err);
      showToast('สร้างไฟล์ Excel ไม่สำเร็จ ลองใหม่อีกทีน้า');
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
      // The API caps how many tasks it will assemble (getTaskWithDetails costs
      // four round trips each). `total` is the pre-cap count, so the page can
      // say every number below is over a subset. An API that predates the field
      // sends nothing, which reads as "not truncated" — the old behaviour.
      setTotalTasks(typeof res.total === 'number' ? res.total : null);
      setLeavingIds(new Set());
      setError(null);
      setLoadedAt(Date.now());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedsLogin(true);
      else setError('เช็คสัญญาณอินเทอร์เน็ตแล้วกดลองใหม่อีกทีน้า');
    }
  }, []);

  /** Best-effort profile fetch — see the note on `profileFailed`. */
  const loadMe = useCallback(() => {
    setProfileFailed(false);
    getMe()
      .then((m) => {
        setMe(m);
        setProfileFailed(false);
      })
      .catch((err) => {
        // The page deliberately still works without a profile (name falls back,
        // and Export stays UNLOCKED so a paying user is never blocked by a
        // failed lookup). But "deliberately degraded" is not the same as
        // "silently wrong": the plan badge vanishes and the reminder picker
        // falls back to the ceiling, so the viewer is told rather than left to
        // wonder why their Pro badge disappeared.
        if (err instanceof ApiError && err.status === 401) setNeedsLogin(true);
        else setProfileFailed(true);
      })
      .finally(() => setMeLoaded(true));
  }, []);

  useEffect(() => {
    void load();
    if (hasSession()) loadMe();
    else setMeLoaded(true);
  }, [load, loadMe]);

  // Age the "อัปเดตเมื่อ …" stamp once a minute. Deliberately NOT an auto-poll:
  // silently swapping the list under someone mid-read is worse than a stale
  // number they can see is stale and refresh on purpose.
  useEffect(() => {
    const id = window.setInterval(() => setNowTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  /** Manual refresh — keeps zone, filters, pins and scroll position. */
  async function handleRefresh(): Promise<void> {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await load();
      if (hasSession() && (profileFailed || !me)) loadMe();
    } finally {
      setRefreshing(false);
    }
  }

  /**
   * Desktop keyboard shortcuts: 1-4 switch status tabs, / focuses search.
   *
   * Both targets live ONLY in the งานของฉัน zone, so both used to die silently
   * everywhere else — `/` found a null ref and did nothing, and 1-4 mutated a
   * `tab` state with nothing on screen to show it. วิธีใช้ advertises them as
   * page shortcuts, so they now carry the reader to the zone that can honour
   * them instead of failing quietly in six of the seven zones.
   *
   * When "/" arrives from another zone the search field does not exist yet, so
   * the focus cannot happen here — it is armed and handed to the effect below,
   * which runs after React has committed the zone. A rAF is NOT enough: it can
   * fire before the commit, which is the same silent no-op being fixed.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') {
        e.preventDefault();
        if (searchRef.current) searchRef.current.focus();
        // Not on this zone yet — the input does not exist to focus. Arm it and
        // let the effect below do it once React has actually mounted the field;
        // a rAF here fires before the commit and focuses nothing.
        else {
          setWantSearchFocus(true);
          gotoMineRef.current();
        }
      } else if (e.key >= '1' && e.key <= '4') {
        const next = TAB_ORDER[Number(e.key) - 1];
        if (!next) return;
        setTab(next);
        gotoMineRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Runs after the งานของฉัน zone has committed, which is the first moment the
  // search input exists to receive focus.
  useEffect(() => {
    if (!wantSearchFocus) return;
    if (section === 'mine' && searchRef.current) {
      searchRef.current.focus();
      setWantSearchFocus(false);
    }
  }, [wantSearchFocus, section]);

  /**
   * Phone only: reveal the day list when a calendar day is picked.
   *
   * Gated on the same 767px breakpoint the stylesheet uses for the compact
   * grid, because on desktop the list is already beside/below the fold-free
   * calendar and yanking the page down would be an unasked-for scroll. Skipped
   * when the day is CLEARED (null) — that is the user tapping the same day
   * again, and scrolling them somewhere on an un-select is disorienting.
   */
  useEffect(() => {
    if (section !== 'calendar' || !selectedDay) return;
    if (!window.matchMedia('(max-width: 767px)').matches) return;
    // Called straight from the effect, NOT deferred through requestAnimationFrame
    // the way the รายงานทีม highlight is. That one has to wait out the zone
    // switch's own scroll-to-top; picking a day starts no competing scroll, so
    // there is nothing to sequence after — and a bare rAF is paused outright
    // while the page is not compositing, which would drop the scroll entirely.
    calListHeadRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selectedDay, section]);

  /* ---- pref setters that also persist ---- */
  const changeFilter = (f: TaskFilter) => {
    setFilter(f);
    saveFilterSort(f, sort);
  };
  const changeSort = (s: TaskSort) => {
    setSort(s);
    saveFilterSort(filter, s);
  };
  /**
   * Zone switch. It also carries the old view-mode preference forward
   * (ปฏิทิน ⇔ 'calendar'), and clears the day filter on the way out — a day
   * chip left armed in a zone that no longer shows the calendar would filter
   * the list from somewhere the user cannot see.
   */
  const changeSection = (s: Section) => {
    setSection(s);
    saveSection(s);
    const v: ViewMode = s === 'calendar' ? 'calendar' : 'list';
    saveViewMode(v);
    if (v === 'list') setSelectedDay(null);
    if (s !== 'team') setHighlightUid(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  /**
   * Latest `changeSection`, for the keyboard-shortcut listener. The listener is
   * registered once (an empty dep array — it must not re-bind on every render),
   * but it has to reach the CURRENT closure, and `changeSection` is rebuilt each
   * render. A ref is what lets the shortcut reuse the one function that knows
   * every zone-switch invariant (persist, clear the day chip, drop the mascot
   * highlight, scroll up) instead of a second copy that would drift from it.
   */
  gotoMineRef.current = () => {
    if (section !== 'mine') changeSection('mine');
  };

  /** KPI card / mascot click → jump to the zone that can act on it. */
  const goToTab = (t: Tab) => {
    setTab(t);
    changeSection('mine');
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
    // 'submitted' is excluded to match the detail page: an item awaiting the
    // creator's review must be accepted/rejected there, not self-marked done.
    const myPending = task.items.filter(
      (i) =>
        i.status !== 'done' &&
        i.status !== 'cancelled' &&
        i.status !== 'submitted' &&
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
  /** The API had more tasks than it was willing to assemble in one payload. */
  const truncated = totalTasks !== null && totalTasks > all.length;
  // เลยกำหนด is its own bucket — กำลังทำ shows only live tasks NOT past deadline
  const overdue = all.filter(isOverdue);
  const active = all.filter((t) => t.status !== 'done' && t.status !== 'cancelled' && !isOverdue(t));
  const finished = all.filter((t) => t.status === 'done');
  const cancelled = all.filter((t) => t.status === 'cancelled');
  const buckets: Record<Tab, TaskDto[]> = { active, overdue, done: finished, cancelled };

  // pipeline: tab bucket → scope filter → sort → pinned-first → search
  const scoped = applyFilter(buckets[tab], filter, viewerUid);
  const sorted = pinnedFirst(applySort(scoped, sort), pins);
  const q = search.trim().toLowerCase();
  const matches = (t: TaskDto) =>
    !q || t.title.toLowerCase().includes(q) || t.items.some((i) => i.title.toLowerCase().includes(q));
  const searched = q ? sorted.filter(matches) : sorted;
  const shownFiltered = searched;

  /**
   * Due-date sections for the list. Only for the deadline sort: under "ชื่อ ก-ฮ"
   * or "ความเร่งด่วน" the reader has explicitly asked for a different spine, and
   * date headers would fight it. Empty array = render one flat list.
   */
  const dueSections = sort === 'deadline' ? groupByDue(shownFiltered) : [];

  /**
   * The ปฏิทิน zone's own list. Deliberately NOT the tab-bucketed pipeline
   * above: a calendar is asking "what is due on this date", and answering it
   * with "…but only the ones in the tab you left selected" is the kind of
   * silent omission people only notice after they have planned around it. With
   * no day picked it falls back to the next two weeks, so the zone is never a
   * calendar sitting above dead space.
   */
  const calendarList = (() => {
    if (selectedDay) return applySort(tasksOnDay(all, selectedDay), 'deadline');
    const now = Date.now();
    const horizon = now + 14 * 86_400_000;
    const upcoming = all.filter((t) => {
      if (t.status === 'cancelled') return false;
      const dl = effectiveDeadline(t);
      if (dl === null) return false;
      const at = new Date(dl).getTime();
      if (at > horizon) return false;
      // A deadline already in the past only belongs here while the task is
      // still live — that is work someone can still act on. A task finished
      // last month is history, not a thing to plan around.
      return at >= now || t.status !== 'done';
    });
    return applySort(upcoming, 'deadline');
  })();

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
  // ring denominator = active + overdue + finished (ยกเลิก is excluded — see
  // overallProgress; the four stat cards below still show every status)
  const ring = overallProgress(all);
  const focus = focusTasks(all);

  const TABS: { key: Tab; label: string; count: number; alert?: boolean }[] = [
    { key: 'active', label: 'กำลังทำ', count: applyFilter(active, filter, viewerUid).length },
    { key: 'overdue', label: 'เลยกำหนด', count: applyFilter(overdue, filter, viewerUid).length, alert: overdue.length > 0 },
    { key: 'done', label: 'เสร็จสิ้น', count: applyFilter(finished, filter, viewerUid).length },
    { key: 'cancelled', label: 'ยกเลิก', count: applyFilter(cancelled, filter, viewerUid).length },
  ];

  const empty = EMPTY_STATE[tab];
  const EmptyIcon = empty.icon;

  // The crew: one character per person holding an assignee slot. Same roster
  // the รายงานทีม table draws, so a face and its row always agree.
  const roster = rosterStats(all, viewerUid);

  /**
   * Zone badges — only counts worth interrupting for. A plain total would put a
   * permanent red dot on every tab and stop meaning anything.
   */
  let awaitingMyReview = 0;
  for (const t of all) {
    if (t.createdByLineUid !== viewerUid || t.status === 'cancelled') continue;
    for (const item of t.items) if (item.status === 'submitted') awaitingMyReview += 1;
  }
  const sectionBadges: Partial<Record<Section, number>> = {
    // งานของฉัน = the work still on this viewer's plate: กำลังทำ + เลยกำหนด.
    // `active` deliberately EXCLUDES overdue tasks (see the bucket split above),
    // so the two add up to every live task without double-counting one. The
    // badge used to carry `overdue.length` alone, which read as "you have
    // nothing" on a page holding a dozen live-but-not-yet-late tasks.
    mine: active.length + overdue.length,
    status: awaitingMyReview,
  };

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
    // One container for every zone — ปฏิทิน used to widen it on its own, which
    // shifted the whole page sideways on each tab switch. See `.wrap`.
    <main className={styles.wrap}>
      <a className={styles.back} href="/dashboard">
        ← กลับคลัง
      </a>
      <div className={styles.titleRow}>
        <h1 className={styles.title}>
          <span className={styles.titleIcon}>
            <ListIcon size={24} />
          </span>
          งานของฉัน
        </h1>
        {tasks !== null && !error && (
          <button
            type="button"
            className={styles.refreshBtn}
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            title="ดึงข้อมูลล่าสุด (ไม่เสียตัวกรองและตำแหน่งที่อ่านอยู่)"
          >
            <span className={refreshing ? styles.refreshSpin : undefined}>
              <RefreshIcon />
            </span>
            {refreshing ? 'กำลังอัปเดต...' : loadedAt ? `อัปเดต ${timeAgo(new Date(loadedAt).toISOString())}` : 'อัปเดต'}
          </button>
        )}
      </div>
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

          {/* A2. data-integrity notices. Both exist so a degraded page never
              passes itself off as a complete one — every stat in every zone is
              derived from the one payload above. */}
          {profileFailed && (
            <div className={styles.dataNotice} role="status">
              <span className={styles.dataNoticeIcon}>
                <AlertIcon size={17} />
              </span>
              <span className={styles.dataNoticeText}>
                โหลดโปรไฟล์ไม่สำเร็จ — ชื่อและแพลนที่แสดงอาจไม่ตรงน้า (รายการงานด้านล่างยังถูกต้องอยู่)
              </span>
              <button type="button" className={styles.dataNoticeBtn} onClick={loadMe}>
                ลองใหม่
              </button>
            </div>
          )}
          {truncated && (
            <div className={`${styles.dataNotice} ${styles.dataNoticeWarn}`} role="status">
              <span className={styles.dataNoticeIcon}>
                <AlertIcon size={17} />
              </span>
              <span className={styles.dataNoticeText}>
                เธอมีงานทั้งหมด {totalTasks} งาน แต่หนูแสดงได้ทีละ {all.length} งาน — ตัวเลขสรุป
                เปอร์เซ็นต์ และกราฟทุกอันในหน้านี้คิดจาก {all.length} งานนี้เท่านั้นน้า
                (หนูเลือกงานที่ยังไม่เสร็จและใกล้กำหนดที่สุดมาให้ก่อน) อยากเห็นครบกว่านี้ กด Export
                Excel ในแท็บ &quot;งานของฉัน&quot; ได้เลย ไฟล์นั้นดึงได้ถึง 500 งาน
              </span>
            </div>
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
              {/* B. zone nav — each entry below is ONE focused data set */}
              <SectionNav section={section} onChange={changeSection} badges={sectionBadges} />
              <p className={styles.sectionHint}>{SECTION_HINT[section]}</p>

              {/* ---------- ZONE 1: ภาพรวม ---------- */}
              {section === 'overview' && (
                <>
                  <TodayFocusBanner
                    tasks={focus.due}
                    overdueCount={focus.overdueCount}
                    collapsed={focusCollapsed}
                    onToggle={toggleFocus}
                  />

                  {/* KPI cards — clicking picks the status AND jumps to the zone
                      that can act on it, so a card is never a dead end */}
                  <div className={styles.statsGrid}>
                    <TaskStatsCard icon={<PlayIcon />} count={active.length} label="กำลังทำ" tone="progress" active={tab === 'active'} onClick={() => goToTab('active')} />
                    <TaskStatsCard icon={<AlertIcon />} count={overdue.length} label="เลยกำหนด" tone="overdue" active={tab === 'overdue'} onClick={() => goToTab('overdue')} />
                    <TaskStatsCard icon={<DoneIcon />} count={finished.length} label="เสร็จสิ้น" tone="done" active={tab === 'done'} onClick={() => goToTab('done')} />
                    <TaskStatsCard icon={<CancelIcon />} count={cancelled.length} label="ยกเลิก" tone="cancelled" active={tab === 'cancelled'} onClick={() => goToTab('cancelled')} />
                  </div>

                  <TaskActivitySummary tasks={all} />
                  <ActivityFeed tasks={all} collapsed={feedCollapsed} onToggle={toggleFeed} />
                </>
              )}

              {/* ---------- ZONE 2: งานของฉัน ---------- */}
              {section === 'mine' && (
                <>
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
                      <button
                        type="button"
                        className={styles.gotoCalBtn}
                        onClick={() => changeSection('calendar')}
                        title="เปิดมุมมองปฏิทิน"
                      >
                        <CalViewIcon /> ปฏิทิน
                      </button>
                    </div>
                    <FilterSortBar
                      filter={filter}
                      sort={sort}
                      onFilter={changeFilter}
                      onSort={changeSort}
                      onExport={() => void handleExport()}
                      exporting={exporting}
                      exportLocked={exportLocked}
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

                  <div className={styles.listArea}>
                    {shownFiltered.length > 0 ? (
                      dueSections.length > 0 ? (
                        /* grouped by due date — see groupByDue */
                        <div style={{ marginTop: 16 }}>
                          {dueSections.map((sec) => (
                            <section key={sec.group} className={styles.dueSection}>
                              <h3
                                className={`${styles.dueHead} ${
                                  sec.group === 'overdue' ? styles.dueHeadOverdue : ''
                                } ${sec.group === 'today' ? styles.dueHeadToday : ''}`}
                              >
                                <span className={styles.dueHeadDot} />
                                {DUE_GROUP_LABEL[sec.group]}
                                <span className={styles.dueHeadCount}>{sec.tasks.length}</span>
                              </h3>
                              <div className={styles.list}>
                                {sec.tasks.map((task) => (
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
                            </section>
                          ))}
                        </div>
                      ) : (
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
                      )
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
                </>
              )}

              {/* ---------- ZONE 3: ติดตามสถานะ ---------- */}
              {section === 'status' && <StatusTrackingSection tasks={all} viewerUid={viewerUid} />}

              {/* ---------- ZONE 4: ปฏิทิน ---------- */}
              {section === 'calendar' && (
                <>
                  <TaskCalendar tasks={all} selected={selectedDay} onSelect={setSelectedDay} />
                  <div className={styles.calListHead} ref={calListHeadRef}>
                    {selectedDay ? (
                      <div className={styles.dayFilterChip}>
                        <span>แสดงงานวันที่ {selectedDayLabel}</span>
                        <button type="button" className={styles.dayFilterClear} aria-label="ล้างตัวกรองวัน" onClick={() => setSelectedDay(null)}>
                          <CloseIcon size={12} />
                        </button>
                      </div>
                    ) : (
                      <span className={styles.calListLabel}>
                        งานที่ต้องส่งใน 14 วันข้างหน้า และงานที่ยังค้างจากที่ผ่านมา
                      </span>
                    )}
                  </div>
                  <div className={styles.listArea}>
                    {calendarList.length > 0 ? (
                      <div className={styles.list} style={{ marginTop: 12 }}>
                        {calendarList.map((task) => (
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
                    ) : (
                      <div className={styles.emptyCard}>
                        <span className={styles.emptyIconWrap}>
                          <CalViewIcon size={30} />
                        </span>
                        <h2 className={styles.emptyTitle}>
                          {selectedDay ? `วันที่ ${selectedDayLabel} ไม่มีงานครบกำหนดน้า` : 'ช่วงนี้ยังไม่มีงานครบกำหนดน้า'}
                        </h2>
                        <p className={styles.emptyBody}>
                          {selectedDay ? 'ลองแตะวันอื่นที่มีจุด หรือล้างตัวกรองวันดูน้า' : 'แตะวันที่มีจุดในปฏิทินเพื่อดูงานของวันนั้นได้เลย'}
                        </p>
                        {selectedDay && (
                          <button type="button" className={styles.emptyCta} onClick={() => setSelectedDay(null)}>
                            ล้างตัวกรองวัน
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* ---------- ZONE 5: รายงานทีม ---------- */}
              {section === 'team' && (
                <TeamReportSection tasks={all} viewerUid={viewerUid} highlightUid={highlightUid} />
              )}

              {/* ---------- ZONE 6: วิเคราะห์ ---------- */}
              {section === 'analysis' && (
                <>
                  <PersonalStatsSection tasks={all} viewerUid={viewerUid} />
                  <WeeklyTrendChart tasks={all} viewerUid={viewerUid} />
                </>
              )}

              {/* ---------- ZONE 7: วิธีใช้ ---------- */}
              {section === 'howto' && <HowToSection />}
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

      {/* H1. the floating crew — one draggable character per teammate. Desktop
          only for this pass (hidden under 1024px / coarse pointers in CSS). */}
      {!error && tasks !== null && all.length > 0 && (
        <MascotLayer
          people={roster}
          onSelect={(uid) => {
            // changeSection keeps the highlight for 'team' specifically — it is
            // only cleared on the way to any OTHER zone
            setHighlightUid(uid);
            changeSection('team');
          }}
        />
      )}
      {createOpen && (
        <CreatePersonalTaskModal
          /* Drives the reminder picker's per-plan cap. `me` is best-effort, and
             an absent plan falls back to the ceiling — the API is the gate. */
          plan={me?.plan ?? null}
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
          /* §5 — the monthly task quota is not a form error: nothing the user
             can retype makes the create succeed. The form closes and the quota
             card takes over, rather than nesting a modal inside a modal. */
          onQuotaExceeded={(feature, resetAt) => {
            setCreateOpen(false);
            setQuotaGate({ feature, resetAt });
          }}
          onPlanGate={() => {
            setCreateOpen(false);
            setUpgradeOpen(true);
          }}
        />
      )}

      {/* H2. Export Excel plan gate — shown instead of the 403 JSON page */}
      <UpgradeModal
        open={upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        badgeText={`ต้องใช้แพลน ${PLAN_DISPLAY_NAME.pro} ขึ้นไป`}
        title="ฟีเจอร์นี้ต้องการแพลน Pro ขึ้นไปน้า"
        subtitle="หนูสรุปงานทุกกลุ่มเป็นไฟล์ Excel ให้ได้เลย — อัปเกรดแล้วกดปุ่มเดียวจบน้า"
        features={EXPORT_PERKS}
      />

      {/* H3. Monthly task quota — a 429 from POST /tasks */}
      <QuotaExceededModal
        open={quotaGate !== null}
        onClose={() => setQuotaGate(null)}
        feature={quotaGate?.feature ?? 'tasks'}
        resetAt={quotaGate?.resetAt}
      />

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
