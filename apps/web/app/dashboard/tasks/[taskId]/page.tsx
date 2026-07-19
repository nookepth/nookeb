'use client';

import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import type { TaskDto, TaskItemDto, TaskStatus, GroupMemberDto } from '@nookeb/shared';
import {
  ApiError,
  hasSession,
  getTask,
  markTaskItemDone,
  updateTaskItemNote,
  acceptTaskItem,
  updateTask,
  cancelTask,
  setTaskItemAssignees,
  addTaskLink,
  deleteTaskLink,
  listGroupTaskMembers,
} from '@/lib/api';
import { startLineLogin } from '@/lib/auth';
import { CloseIcon } from '@/components/icons';
import styles from '../tasks.module.css';

const TYPE_LABEL: Record<TaskDto['type'], string> = {
  single: 'งานเดียว',
  multi: 'แยกรายการ',
  recurring: 'งานประจำ',
};

const STATUS_BADGE: Record<TaskStatus, { label: string; bg: string; fg: string }> = {
  pending: { label: 'รอดำเนินการ', bg: '#f3f4f6', fg: '#374151' },
  in_progress: { label: 'กำลังทำ', bg: '#fef3c7', fg: '#b45309' },
  done: { label: 'เสร็จแล้ว', bg: '#d1fae5', fg: '#047857' },
  cancelled: { label: 'ยกเลิก', bg: '#fee2e2', fg: '#b91c1c' },
};

/** Per-sub-task status pill: กำลังทำ=yellow, เสร็จแล้ว=green, ยกเลิก/ยังไม่เริ่ม=gray. */
const ITEM_STATUS_PILL: Record<TaskStatus, { label: string; bg: string; fg: string }> = {
  pending: { label: 'ยังไม่เริ่ม', bg: '#f3f4f6', fg: '#6b7280' },
  in_progress: { label: 'กำลังทำ', bg: '#fef3c7', fg: '#b45309' },
  done: { label: 'เสร็จแล้ว', bg: '#d1fae5', fg: '#047857' },
  cancelled: { label: 'ยกเลิก', bg: '#f3f4f6', fg: '#6b7280' },
};

const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

/** Short date, no year — matches the LIFF deadline chip. */
function formatShortDeadline(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO → 'YYYY-MM-DDTHH:mm' in local time for <input type="datetime-local">. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

function buildGoogleCalendarUrl(title: string, deadlineIso: string | null): string {
  if (!deadlineIso) return 'https://calendar.google.com';
  const fmt = (d: Date) => {
    const date = new Date(d);
    date.setSeconds(0, 0);
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
      date.getFullYear().toString() +
      pad(date.getMonth() + 1) +
      pad(date.getDate()) +
      'T' +
      pad(date.getHours()) +
      pad(date.getMinutes()) +
      '00'
    );
  };
  const start = new Date(deadlineIso);
  const startStr = fmt(start);
  const text = encodeURIComponent(title || '');
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${text}&dates=${startStr}/${startStr}`;
}

/* ---- small inline icons (brand rule: no emoji in UI text) ---- */

function CalendarIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="M3.5 9.5h17M8 2.8v4M16 2.8v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function CheckIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="m5 12.5 4.5 4.5L19 7.5"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function UsersIcon({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="9" cy="8" r="3.5" stroke="currentColor" strokeWidth="2" />
      <path d="M3 19c0-3 2.7-5 6-5s6 2 6 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M15.5 5.2a3.5 3.5 0 0 1 0 5.6M17.8 14.6c1.9.8 3.2 2.4 3.2 4.4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ---- small presentational helpers (mirror liff/tasks/components.tsx) ---- */

function Avatar({ member, size = 28 }: { member: GroupMemberDto; size?: number }) {
  const initial = (member.displayName ?? '?').trim().charAt(0) || '?';
  const style = { width: size, height: size, fontSize: size * 0.42 };
  return member.pictureUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- LINE CDN avatar, remote domain varies
    <img className={styles.tdAvatar} style={style} src={member.pictureUrl} alt="" />
  ) : (
    <div className={styles.tdAvatar} style={style}>
      {initial}
    </div>
  );
}

function AvatarStack({ members, size = 24, max = 4 }: { members: GroupMemberDto[]; size?: number; max?: number }) {
  const shown = members.slice(0, max);
  return (
    <div className={styles.tdStack}>
      {shown.map((m) => (
        <div key={m.lineUid} className={styles.tdStackItem}>
          <Avatar member={m} size={size} />
        </div>
      ))}
      {members.length > max && <span className={styles.tdStackMore}>+{members.length - max}</span>}
    </div>
  );
}

function DeadlineChip({ iso }: { iso: string | null }) {
  if (!iso) return <span className={styles.tdDeadlineChip}>ตาม deadline งาน</span>;
  const overdue = new Date(iso).getTime() < Date.now();
  return (
    <span className={`${styles.tdDeadlineChip} ${overdue ? styles.tdDeadlineChipOverdue : ''}`}>
      {formatShortDeadline(iso)}
    </span>
  );
}

function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className={styles.tdMemberList} aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={styles.tdSkeletonRow}>
          <div className={styles.tdSkeletonCircle} />
          <div className={styles.tdSkeletonBar} style={{ width: `${45 + (i % 3) * 15}%` }} />
        </div>
      ))}
    </div>
  );
}

function StateNotice({
  title,
  body,
  onRetry,
  retryLabel = 'ลองใหม่อีกที',
}: {
  title: string;
  body: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className={styles.tdStateCard}>
      <div className={styles.tdStateIcon}>
        <UsersIcon />
      </div>
      <p className={styles.tdStateTitle}>{title}</p>
      <p className={styles.tdStateText}>{body}</p>
      {onRetry && (
        <button type="button" className={styles.tdRetryBtn} onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}

export default function TaskDetailPage({ params }: { params: { taskId: string } }) {
  const taskId = params.taskId;
  const [task, setTask] = useState<TaskDto | null>(null);
  const [viewerUid, setViewerUid] = useState<string>('');
  const [state, setState] = useState<'loading' | 'ready' | 'login' | 'forbidden' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // ---- editing UI state ----
  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDeadline, setEditDeadline] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [addingLink, setAddingLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkLabel, setLinkLabel] = useState('');
  // per-item transient inputs
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});
  const [noteEditing, setNoteEditing] = useState<Record<string, boolean>>({});
  // assignee editor
  const [assigneeItemId, setAssigneeItemId] = useState<string | null>(null);
  const [roster, setRoster] = useState<GroupMemberDto[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  function showToast(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3200);
  }

  const load = useCallback(async () => {
    if (!hasSession()) {
      setState('login');
      return;
    }
    try {
      const res = await getTask(taskId);
      setTask(res.task);
      setViewerUid(res.viewerLineUid);
      setState('ready');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setState('login');
      else if (err instanceof ApiError && err.status === 403) setState('forbidden');
      else setState('error');
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = () => {
    setState('loading');
    void load();
  };

  /** Run a mutating call, adopt its returned task, surface a friendly error. */
  async function run<T extends { task: TaskDto }>(
    fn: () => Promise<T>,
    okMsg?: string,
    errMsg = 'ทำรายการไม่สำเร็จ ลองใหม่อีกทีน้า',
  ): Promise<T | null> {
    if (busy) return null;
    setBusy(true);
    try {
      const res = await fn();
      setTask(res.task);
      if (okMsg) showToast(okMsg);
      return res;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setState('login');
      } else {
        showToast(errMsg);
      }
      return null;
    } finally {
      setBusy(false);
    }
  }

  // ---- states ----
  if (state === 'login') {
    return (
      <div className="center-page">
        <Image src="/logo.png" alt="หนูเก็บ" width={120} height={120} className="login-logo" priority />
        <h1>หนูเก็บ</h1>
        <p>เข้าสู่ระบบด้วย LINE เพื่อดูงานนี้</p>
        <button className="btn" onClick={startLineLogin}>
          เข้าสู่ระบบด้วย LINE
        </button>
      </div>
    );
  }
  if (state === 'loading') {
    return (
      <main className={styles.wrap}>
        <a className={styles.back} href="/dashboard/tasks">
          ← กลับรายการงาน
        </a>
        <div className={styles.card} style={{ marginBottom: 12 }}>
          <div className={styles.tdSkeletonBar} style={{ width: '60%', height: 20, marginBottom: 10 }} />
          <div className={styles.tdSkeletonBar} style={{ width: '35%' }} />
        </div>
        <ListSkeleton rows={4} />
      </main>
    );
  }
  if (state === 'forbidden') {
    return (
      <main className={styles.wrap}>
        <a className={styles.back} href="/dashboard/tasks">
          ← กลับรายการงาน
        </a>
        <StateNotice
          title="งานนี้เป็นของกลุ่มที่เธอยังไม่ได้อยู่ด้วยน้า"
          body="ลองส่งข้อความในกลุ่มนั้นสักครั้ง แล้วกดลองใหม่อีกทีน้า"
          onRetry={retry}
        />
      </main>
    );
  }
  if (state === 'error' || !task) {
    return (
      <main className={styles.wrap}>
        <a className={styles.back} href="/dashboard/tasks">
          ← กลับรายการงาน
        </a>
        <StateNotice
          title="โหลดงานไม่สำเร็จน้า"
          body="เช็คสัญญาณอินเทอร์เน็ตแล้วลองใหม่อีกทีน้า"
          onRetry={retry}
        />
      </main>
    );
  }

  const isCreator = task.createdByLineUid === viewerUid;
  const isRecurring = task.type === 'recurring';
  const isClosed = task.status === 'done' || task.status === 'cancelled';
  const badge = STATUS_BADGE[task.status];
  const calendarDeadline = task.globalDeadline ?? task.items.find((i) => i.deadline)?.deadline ?? null;
  const doneItems = task.items.filter((i) => i.status === 'done').length;
  const pct = task.items.length > 0 ? Math.round((doneItems / task.items.length) * 100) : 0;

  // ---- actions ----
  const openEdit = () => {
    setEditTitle(task.title);
    setEditDeadline(toLocalInput(task.globalDeadline));
    setEditDescription(task.items[0]?.description ?? '');
    setEditOpen(true);
  };
  const saveEdit = async () => {
    const patch: { title?: string; globalDeadline?: string; description?: string } = {};
    if (editTitle.trim() && editTitle.trim() !== task.title) patch.title = editTitle.trim();
    if (!isRecurring && editDeadline) {
      const iso = new Date(editDeadline).toISOString();
      if (iso !== task.globalDeadline) patch.globalDeadline = iso;
    }
    // Task-level description maps to the first item (see API patchTaskSchema).
    // Send the trimmed value (empty clears it) only when it actually changed.
    const currentDesc = task.items[0]?.description ?? '';
    if (editDescription.trim() !== currentDesc) patch.description = editDescription.trim();
    if (Object.keys(patch).length === 0) {
      setEditOpen(false);
      return;
    }
    const res = await run(() => updateTask(task.id, patch), 'บันทึกการแก้ไขแล้วน้า');
    if (res) setEditOpen(false);
  };

  const doCancel = async () => {
    if (!window.confirm(`ยกเลิกงาน "${task.title}" ใช่ไหมน้า? หนูจะหยุดเตือนและบอกกลุ่มให้`)) return;
    await run(() => cancelTask(task.id), 'ยกเลิกงานแล้วน้า');
  };

  const doAddLink = async () => {
    const url = linkUrl.trim();
    if (!url) return;
    const res = await run(
      () => addTaskLink(task.id, url, linkLabel.trim() || undefined),
      'แนบลิงก์แล้วน้า',
      'แนบลิงก์ไม่สำเร็จ — ตรวจว่าเป็นลิงก์ http/https ที่ถูกต้องน้า',
    );
    if (res) {
      setLinkUrl('');
      setLinkLabel('');
      setAddingLink(false);
    }
  };

  const doDone = async (item: TaskItemDto) => {
    const note = noteDraft[item.id] ?? '';
    const res = await run(() => markTaskItemDone(task.id, item.id, note), 'บันทึกว่าเสร็จแล้วน้า');
    if (res) setNoteDraft((d) => ({ ...d, [item.id]: '' }));
  };

  const doAccept = (item: TaskItemDto) =>
    run(() => acceptTaskItem(task.id, item.id), 'รับทราบแล้วน้า สู้ๆ น้า');

  const saveNote = async (item: TaskItemDto) => {
    const note = noteDraft[item.id] ?? '';
    const res = await run(() => updateTaskItemNote(task.id, item.id, note), 'แก้หมายเหตุแล้วน้า');
    if (res) setNoteEditing((e) => ({ ...e, [item.id]: false }));
  };

  const openAssigneeEditor = async (item: TaskItemDto) => {
    setAssigneeItemId(item.id);
    setPicked(new Set(item.assignees.map((a) => a.lineUid)));
    setRoster(null);
    try {
      const res = await listGroupTaskMembers(task.groupLineId);
      setRoster(res.members);
    } catch {
      setRoster([]);
      showToast('โหลดรายชื่อสมาชิกไม่สำเร็จน้า');
    }
  };
  const saveAssignees = async () => {
    if (!assigneeItemId) return;
    if (picked.size === 0) {
      showToast('ต้องมีผู้รับผิดชอบอย่างน้อย 1 คนน้า');
      return;
    }
    const res = await run(
      () => setTaskItemAssignees(task.id, assigneeItemId, [...picked]),
      'แก้ผู้รับผิดชอบแล้วน้า',
    );
    if (res) setAssigneeItemId(null);
  };

  return (
    <main className={styles.wrap} style={{ paddingBottom: 60 }}>
      <a className={styles.back} href="/dashboard/tasks">
        ← กลับรายการงาน
      </a>

      {/* header card: title + status + (task type badge kept from the dashboard
          view) + LIFF-style deadline pill */}
      <div className={styles.card}>
        <div className={styles.detailTitleRow}>
          <h1 className={styles.detailTitle}>{task.title}</h1>
          <span className={styles.statusBadge} style={{ background: badge.bg, color: badge.fg }}>
            {badge.label}
          </span>
        </div>
        <div className={styles.detailMetaRow}>
          <span className={styles.typeTag}>{TYPE_LABEL[task.type]}</span>
          {task.globalDeadline && <DeadlineChip iso={task.globalDeadline} />}
        </div>
      </div>

      {/* action buttons row — evenly spaced, consistent border-radius */}
      {((isCreator && !isClosed) || calendarDeadline) && (
        <div className={styles.detailActions}>
          {calendarDeadline && (
            <a
              className={styles.secondaryBtn}
              style={{ flex: 1, padding: '13px 10px', whiteSpace: 'nowrap' }}
              href={buildGoogleCalendarUrl(task.title, calendarDeadline)}
            >
              <CalendarIcon /> บันทึกลงปฏิทิน
            </a>
          )}
          {isCreator && !isClosed && (
            <button
              type="button"
              className={styles.secondaryBtn}
              style={{ flex: 1, padding: '13px 10px' }}
              onClick={openEdit}
              disabled={busy}
            >
              แก้ไขงาน
            </button>
          )}
          {isCreator && !isClosed && (
            <button
              type="button"
              className={styles.dangerBtn}
              style={{ flex: 1, padding: '13px 10px' }}
              onClick={doCancel}
              disabled={busy}
            >
              ยกเลิกงาน
            </button>
          )}
        </div>
      )}

      {/* progress bar */}
      <div className={styles.card} style={{ marginTop: 14 }}>
        <div className={styles.detailTitleRow} style={{ marginBottom: 8 }}>
          <span className={styles.fieldLabel} style={{ margin: 0 }}>
            ความคืบหน้า
          </span>
          <span className={styles.fieldLabel} style={{ margin: 0 }}>
            {doneItems}/{task.items.length}
          </span>
        </div>
        <div className={styles.progressTrack}>
          <div className={styles.progressFill} style={{ width: `${pct}%` }} />
        </div>
      </div>

      {/* links */}
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>ลิงก์ที่แนบ</h2>
          {isCreator && !isClosed && !addingLink && (
            <button type="button" className={styles.ghostBtn} onClick={() => setAddingLink(true)}>
              เพิ่มลิงก์
            </button>
          )}
        </div>
        {task.links.length === 0 && !addingLink && (
          <p className={styles.hint} style={{ margin: 0 }}>
            ยังไม่มีลิงก์แนบน้า
          </p>
        )}
        <div className={styles.list}>
          {task.links.map((link) => (
            <div key={link.id} className={`${styles.card} ${styles.tdLinkCard}`}>
              <a className={styles.linkAnchor} href={link.url} target="_blank" rel="noreferrer">
                {link.label || link.url}
              </a>
              {isCreator && !isClosed && (
                <button
                  type="button"
                  className={styles.iconDelete}
                  aria-label="ลบลิงก์"
                  disabled={busy}
                  onClick={() => void run(() => deleteTaskLink(task.id, link.id), 'ลบลิงก์แล้วน้า')}
                >
                  <CloseIcon size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
        {addingLink && (
          <div className={styles.inlineForm} style={{ marginTop: 10 }}>
            <input
              className={styles.input}
              placeholder="https://…"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              inputMode="url"
            />
            <input
              className={styles.input}
              placeholder="ชื่อลิงก์ (ไม่ใส่ก็ได้)"
              value={linkLabel}
              onChange={(e) => setLinkLabel(e.target.value)}
            />
            <div className={styles.inlineFormRow}>
              <button type="button" className={styles.primaryBtn} onClick={() => void doAddLink()} disabled={busy}>
                แนบลิงก์
              </button>
              <button
                type="button"
                className={styles.ghostBtn}
                onClick={() => {
                  setAddingLink(false);
                  setLinkUrl('');
                  setLinkLabel('');
                }}
              >
                ยกเลิก
              </button>
            </div>
          </div>
        )}
      </section>

      {/* items */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle} style={{ marginBottom: 12 }}>
          รายการงาน
        </h2>
        <div className={styles.list}>
          {task.items.map((item, idx) => {
            const mine = item.assignees.find((a) => a.lineUid === viewerUid);
            const itemDone = item.status === 'done';
            const canAct = mine && !isClosed;
            const ipill = ITEM_STATUS_PILL[item.status];
            return (
              <article key={item.id} className={styles.tdItemCard}>
                <div className={styles.tdItemTopRow}>
                  <span className={styles.tdNumBadge} style={itemDone ? { background: '#059669' } : undefined}>
                    {itemDone ? <CheckIcon size={13} /> : idx + 1}
                  </span>
                  <div className={styles.tdItemBody}>
                    <div className={styles.detailTitleRow} style={{ alignItems: 'flex-start', gap: 8 }}>
                      <p className={styles.tdItemTitle}>{item.title}</p>
                      <span
                        className={styles.statusBadge}
                        style={{ background: ipill.bg, color: ipill.fg, flexShrink: 0 }}
                      >
                        {ipill.label}
                      </span>
                    </div>
                    {item.description && (
                      <p className={styles.hint} style={{ margin: '6px 0 0' }}>
                        {item.description}
                      </p>
                    )}
                    <div className={styles.tdMetaRow}>
                      <AvatarStack members={item.assignees} size={24} max={4} />
                      <DeadlineChip iso={item.deadline} />
                    </div>
                  </div>
                </div>

                {/* creator controls */}
                {isCreator && !isClosed && (
                  <div className={styles.tdCreatorControls}>
                    <button type="button" className={styles.ghostBtn} onClick={() => void openAssigneeEditor(item)}>
                      แก้ผู้รับผิดชอบ
                    </button>
                  </div>
                )}

                {/* per-assignee status + notes */}
                <div>
                  {item.assignees.map((a) => {
                    const stateLabel = a.doneAt
                      ? { txt: 'เสร็จแล้ว', cls: styles.stateDone }
                      : a.acceptedAt
                        ? { txt: 'รับทราบแล้ว', cls: styles.stateAccepted }
                        : { txt: 'ยังไม่เสร็จ', cls: styles.statePending };
                    return (
                      <div key={a.id}>
                        <div className={styles.assigneeRow}>
                          <span className={styles.assigneeName}>{a.displayName || 'สมาชิก'}</span>
                          <span className={`${styles.assigneeState} ${stateLabel.cls}`}>{stateLabel.txt}</span>
                        </div>
                        {a.doneNote && <p className={styles.noteText}>{a.doneNote}</p>}
                      </div>
                    );
                  })}
                </div>

                {/* viewer controls for their own assignment */}
                {canAct && !mine!.doneAt && (
                  <div>
                    <textarea
                      className={styles.textarea}
                      placeholder="หมายเหตุ (ไม่ใส่ก็ได้) เช่น ส่งไฟล์ในกลุ่มแล้ว"
                      value={noteDraft[item.id] ?? ''}
                      onChange={(e) => setNoteDraft((d) => ({ ...d, [item.id]: e.target.value }))}
                      maxLength={500}
                    />
                    <div className={styles.inlineFormRow} style={{ marginTop: 8 }}>
                      <button type="button" className={styles.primaryBtn} onClick={() => void doDone(item)} disabled={busy}>
                        เสร็จแล้ว
                      </button>
                      {!mine!.acceptedAt && (
                        <button
                          type="button"
                          className={styles.ghostBtn}
                          onClick={() => void doAccept(item)}
                          disabled={busy}
                        >
                          รับทราบ
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* viewer already done → edit own note */}
                {canAct && mine!.doneAt && (
                  <div>
                    {noteEditing[item.id] ? (
                      <>
                        <textarea
                          className={styles.textarea}
                          value={noteDraft[item.id] ?? mine!.doneNote ?? ''}
                          onChange={(e) => setNoteDraft((d) => ({ ...d, [item.id]: e.target.value }))}
                          maxLength={500}
                        />
                        <div className={styles.inlineFormRow} style={{ marginTop: 8 }}>
                          <button
                            type="button"
                            className={styles.primaryBtn}
                            onClick={() => void saveNote(item)}
                            disabled={busy}
                          >
                            บันทึกหมายเหตุ
                          </button>
                          <button
                            type="button"
                            className={styles.ghostBtn}
                            onClick={() => setNoteEditing((e) => ({ ...e, [item.id]: false }))}
                          >
                            ยกเลิก
                          </button>
                        </div>
                      </>
                    ) : (
                      <button
                        type="button"
                        className={styles.ghostBtn}
                        style={{ padding: 4 }}
                        onClick={() => {
                          setNoteDraft((d) => ({ ...d, [item.id]: mine!.doneNote ?? '' }));
                          setNoteEditing((e) => ({ ...e, [item.id]: true }));
                        }}
                      >
                        {mine!.doneNote ? 'แก้หมายเหตุของฉัน' : 'เพิ่มหมายเหตุ'}
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>

      {/* edit sheet */}
      {editOpen && (
        <div className={styles.tdSheetOverlay} onClick={() => setEditOpen(false)}>
          <div className={styles.tdSheet} onClick={(e) => e.stopPropagation()}>
            <div className={styles.tdSheetHandle} />
            <label className={styles.fieldLabel}>ชื่องาน</label>
            <input
              className={styles.input}
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              maxLength={200}
            />
            {!isRecurring ? (
              <>
                <label className={styles.fieldLabel} style={{ marginTop: 12 }}>
                  กำหนดส่ง
                </label>
                <div className={styles.tdDateInputWrap}>
                  <input
                    className={styles.input}
                    type="datetime-local"
                    style={{ border: 'none' }}
                    value={editDeadline}
                    onChange={(e) => setEditDeadline(e.target.value)}
                  />
                </div>
              </>
            ) : (
              <p className={styles.hint} style={{ margin: '10px 0 0' }}>
                งานประจำเลื่อนรอบเองตามกำหนด แก้กำหนดส่งไม่ได้น้า
              </p>
            )}
            <label className={styles.fieldLabel} style={{ marginTop: 12 }}>
              รายละเอียด (ไม่บังคับ)
            </label>
            <textarea
              className={styles.textarea}
              placeholder="อธิบายงานเพิ่มเติม..."
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              maxLength={1000}
            />
            <button
              type="button"
              className={styles.primaryBtn}
              style={{ marginTop: 16, width: '100%', justifyContent: 'center' }}
              onClick={() => void saveEdit()}
              disabled={busy}
            >
              บันทึก
            </button>
          </div>
        </div>
      )}

      {/* assignee editor sheet */}
      {assigneeItemId && (
        <div className={styles.tdSheetOverlay} onClick={() => setAssigneeItemId(null)}>
          <div className={styles.tdSheet} onClick={(e) => e.stopPropagation()}>
            <div className={styles.tdSheetHandle} />
            <h2 className={styles.sectionTitle} style={{ marginBottom: 12 }}>
              เลือกผู้รับผิดชอบ
            </h2>
            {roster === null ? (
              <ListSkeleton rows={4} />
            ) : roster.length === 0 ? (
              <p className={styles.hint} style={{ margin: 0 }}>
                ยังไม่มีสมาชิกในกลุ่มให้เลือกน้า ลองให้เพื่อนส่งข้อความในกลุ่มก่อน
              </p>
            ) : (
              <div className={styles.tdMemberList}>
                {roster.map((m) => {
                  const on = picked.has(m.lineUid);
                  return (
                    <button
                      key={m.lineUid}
                      type="button"
                      className={`${styles.tdMemberRow} ${on ? styles.tdMemberRowSelected : ''}`}
                      aria-pressed={on}
                      onClick={() =>
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (next.has(m.lineUid)) next.delete(m.lineUid);
                          else next.add(m.lineUid);
                          return next;
                        })
                      }
                    >
                      <Avatar member={m} size={40} />
                      <span className={styles.tdMemberName}>{m.displayName ?? 'สมาชิก'}</span>
                      <span className={`${styles.tdCheckmark} ${on ? styles.tdCheckmarkOn : ''}`}>
                        <CheckIcon />
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            <button
              type="button"
              className={styles.primaryBtn}
              style={{ marginTop: 16, width: '100%', justifyContent: 'center' }}
              onClick={() => void saveAssignees()}
              disabled={busy || picked.size === 0}
            >
              บันทึก
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div className={styles.toast} role="status">
          {toast}
        </div>
      )}
    </main>
  );
}
