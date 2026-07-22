'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from '../tasks.module.css';
import {
  apiFetch,
  initLiff,
  reconnectLiff,
  resetLiff,
  resolveGroupId,
  type LiffState,
} from '../../../../lib/liff';
import { AvatarStack, DeadlineChip, IconUsers, ListSkeleton, StateNotice } from '../components';

/**
 * ห้องทีม (Team Room) — every task in one LINE group.
 *
 * Route note: this lives UNDER /liff/tasks/ rather than at a top-level
 * /liff/team-room, because the LIFF app's endpoint URL is `${WEB_URL}/liff/tasks`
 * and a `https://liff.line.me/{id}/…` deep link is resolved RELATIVE to that
 * endpoint. A page outside this subtree simply isn't reachable from a LINE card
 * without registering a second LIFF app (another console setup + env var).
 *
 * Identity: `?groupId=` (the same unguessable capability every task card
 * carries) or `?spaceId=` when arriving from the dashboard side. The group id is
 * preferred — tasks are keyed by group, and a brand-new group has no space yet.
 */

interface AssigneeDto {
  lineUid: string;
  displayName: string | null;
  pictureUrl: string | null;
  doneAt: string | null;
}
interface ItemDto {
  id: string;
  title: string;
  deadline: string | null;
  status: string;
  assignees: AssigneeDto[];
}
interface TaskDto {
  id: string;
  title: string;
  type: string;
  status: string;
  globalDeadline: string | null;
  createdByLineUid: string;
  items: ItemDto[];
}
interface RoomResponse {
  space: { id: string; name: string; memberCount: number } | null;
  groupLineId: string;
  memberCount: number;
  tasks: TaskDto[];
  viewerLineUid: string;
}

type Tab = 'all' | 'mine';
type StatusFilter = 'active' | 'done' | 'cancelled';

const STATUS_PILL: Record<string, { label: string; bg: string; fg: string }> = {
  pending: { label: 'รอดำเนินการ', bg: '#f3f4f6', fg: '#374151' },
  in_progress: { label: 'กำลังทำ', bg: '#fef3c7', fg: '#b45309' },
  done: { label: 'เสร็จแล้ว', bg: '#d1fae5', fg: '#047857' },
  cancelled: { label: 'ยกเลิก', bg: '#fee2e2', fg: '#b91c1c' },
};

const STATUS_TABS: { key: StatusFilter; label: string }[] = [
  { key: 'active', label: 'กำลังดำเนินการ' },
  { key: 'done', label: 'เสร็จแล้ว' },
  { key: 'cancelled', label: 'ยกเลิก' },
];

function queryParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

/** Progress across a task's items — the one number a team room is scanned for. */
function progressOf(task: TaskDto): { done: number; total: number } {
  const done = task.items.filter((i) => i.status === 'done').length;
  return { done, total: task.items.length };
}

export default function TeamRoomPage() {
  const router = useRouter();
  const [room, setRoom] = useState<RoomResponse | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'forbidden' | 'unauth' | 'nogroup' | 'error'>(
    'loading',
  );
  const [tab, setTab] = useState<Tab>('all');
  const [status, setStatus] = useState<StatusFilter>('active');

  const applyAuthError = useCallback((s: LiffState): boolean => {
    if (s.authed) return true;
    setState(s.authError === 'network' ? 'error' : 'unauth');
    return false;
  }, []);

  const fetchRoom = useCallback(async (liffGroupId: string | null): Promise<void> => {
    // Group id first (tasks are group-keyed and it works before a space exists);
    // spaceId is the dashboard-side entry, and passes the group id along too so
    // the capability path can enrol the caller.
    const groupId = resolveGroupId() ?? liffGroupId;
    const spaceId = queryParam('spaceId');
    if (!groupId && !spaceId) return setState('nogroup');

    const url = groupId
      ? `/api-proxy/groups/${encodeURIComponent(groupId)}/room`
      : `/api-proxy/spaces/${encodeURIComponent(spaceId!)}/tasks`;

    const res = await apiFetch(url).catch(() => null);
    if (!res) return setState('error');
    if (res.status === 401) return setState('unauth');
    if (res.status === 403) return setState('forbidden');
    if (!res.ok) return setState('error');
    setRoom((await res.json()) as RoomResponse);
    setState('ready');
  }, []);

  useEffect(() => {
    initLiff()
      .then((s) => {
        if (applyAuthError(s)) return fetchRoom(s.groupId);
      })
      .catch(() => setState('error'));
  }, [fetchRoom, applyAuthError]);

  const retry = () => {
    setState('loading');
    resetLiff()
      .then((s) => {
        if (applyAuthError(s)) return fetchRoom(s.groupId);
      })
      .catch(() => setState('error'));
  };

  const visible = useMemo(() => {
    if (!room) return [];
    return room.tasks.filter((t) => {
      if (tab === 'mine') {
        const mine =
          t.createdByLineUid === room.viewerLineUid ||
          t.items.some((i) => i.assignees.some((a) => a.lineUid === room.viewerLineUid));
        if (!mine) return false;
      }
      if (status === 'done') return t.status === 'done';
      if (status === 'cancelled') return t.status === 'cancelled';
      return t.status !== 'done' && t.status !== 'cancelled';
    });
  }, [room, tab, status]);

  // ---- states ----
  if (state === 'loading') {
    return (
      <main className={styles.page}>
        <header className={styles.header}>
          <div className={styles.skeletonBar} style={{ width: '50%', height: 22, marginBottom: 10 }} />
          <div className={styles.skeletonBar} style={{ width: '30%' }} />
        </header>
        <ListSkeleton rows={5} />
      </main>
    );
  }
  if (state === 'unauth') {
    return (
      <main className={styles.page}>
        <StateNotice
          title="ต้องเชื่อมต่อ LINE ก่อนน้า"
          body="กด 'เชื่อมต่ออีกครั้ง' เพื่อเข้าสู่ระบบด้วย LINE ใหม่น้า"
          onRetry={() => {
            setState('loading');
            reconnectLiff()
              .then((s) => {
                if (applyAuthError(s)) return fetchRoom(s.groupId);
              })
              .catch(() => setState('error'));
          }}
          retryLabel="เชื่อมต่ออีกครั้ง"
        />
      </main>
    );
  }
  if (state === 'nogroup') {
    return (
      <main className={styles.page}>
        <StateNotice
          title="เปิดห้องทีมจากในกลุ่มน้า"
          body="พิมพ์ 'หนูเก็บห้องทีม' ในกลุ่มที่มีหนูเก็บอยู่ แล้วกดปุ่มเปิดห้องทีมในการ์ดน้า"
          onRetry={retry}
        />
      </main>
    );
  }
  if (state === 'forbidden') {
    return (
      <main className={styles.page}>
        <StateNotice
          title="ยังไม่เห็นเราในกลุ่มนี้เลยน้า"
          body="ลองส่งข้อความในกลุ่มสักครั้ง แล้วกดลองใหม่อีกทีน้า"
          onRetry={retry}
        />
      </main>
    );
  }
  if (state === 'error' || !room) {
    return (
      <main className={styles.page}>
        <StateNotice title="โหลดห้องทีมไม่สำเร็จน้า" body="เช็คสัญญาณอินเทอร์เน็ตแล้วลองใหม่อีกทีน้า" onRetry={retry} />
      </main>
    );
  }

  const createUrl = `/liff/tasks/create?groupId=${encodeURIComponent(room.groupLineId)}`;

  return (
    <main className={styles.page} style={{ paddingBottom: 100 }}>
      <header className={styles.roomHero}>
        <p className={styles.heroLabel}>ห้องทีม</p>
        <div className={styles.roomHeroRow}>
          <h1 className={styles.roomHeroTitle}>{room.space?.name ?? 'ทีมของเรา'}</h1>
          <span className={styles.roomMemberChip}>
            <IconUsers size={14} /> {room.memberCount} คน
          </span>
        </div>
        <p className={styles.roomHeroMeta}>{room.tasks.length} งานในห้องนี้</p>
      </header>

      <div className={styles.roomToolbar}>
        {/* งานทั้งหมด | ของฉัน — segmented control */}
        <div className={styles.roomSegment} role="tablist">
          {(['all', 'mine'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              onClick={() => setTab(t)}
              aria-selected={tab === t}
              className={`${styles.roomSegmentBtn} ${tab === t ? styles.roomSegmentBtnActive : ''}`}
            >
              {t === 'all' ? 'งานทั้งหมด' : 'ของฉัน'}
            </button>
          ))}
        </div>

        {/* status filter chips */}
        <div className={styles.roomChips}>
          {STATUS_TABS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setStatus(s.key)}
              aria-pressed={status === s.key}
              className={`${styles.roomChip} ${status === s.key ? styles.roomChipActive : ''}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* task grid */}
      <section className={styles.roomGrid}>
        {visible.length === 0 ? (
          <p className={styles.roomEmpty}>
            {tab === 'mine'
              ? 'ยังไม่มีงานที่เกี่ยวกับเราในหมวดนี้น้า'
              : 'ยังไม่มีงานในหมวดนี้น้า กดปุ่มด้านล่างสร้างงานแรกได้เลย'}
          </p>
        ) : (
          visible.map((task) => {
            const pill = STATUS_PILL[task.status] ?? STATUS_PILL.pending!;
            const { done, total } = progressOf(task);
            // Show every assignee across the task's items, deduped by uid.
            const people = [
              ...new Map(
                task.items.flatMap((i) => i.assignees).map((a) => [a.lineUid, a]),
              ).values(),
            ];
            const deadline =
              task.globalDeadline ?? task.items.find((i) => i.deadline)?.deadline ?? null;
            return (
              <a key={task.id} href={`/liff/tasks/${task.id}`} className={styles.roomCard}>
                <div className={styles.roomCardTop}>
                  <h3 className={styles.roomCardTitle}>{task.title}</h3>
                  <span
                    className={styles.statusBadge}
                    style={{ background: pill.bg, color: pill.fg, flexShrink: 0 }}
                  >
                    {pill.label}
                  </span>
                </div>

                <div className={styles.roomCardMeta}>
                  <DeadlineChip iso={deadline} />
                  <AvatarStack members={people} size={24} max={4} />
                </div>

                {total > 1 && (
                  <div className={styles.roomProgress}>
                    <div className={styles.roomProgressHead}>
                      <span>ความคืบหน้า</span>
                      <span>
                        {done}/{total}
                      </span>
                    </div>
                    <div className={styles.progressTrack}>
                      <div
                        className={styles.progressFill}
                        style={{ width: `${Math.round((done / total) * 100)}%` }}
                      />
                    </div>
                  </div>
                )}
              </a>
            );
          })
        )}
      </section>

      <div className={styles.stickyFooter}>
        <button
          type="button"
          className={styles.primaryBtn}
          style={{ width: '100%' }}
          onClick={() => router.push(createUrl)}
        >
          + สร้างงานใหม่
        </button>
      </div>
    </main>
  );
}
