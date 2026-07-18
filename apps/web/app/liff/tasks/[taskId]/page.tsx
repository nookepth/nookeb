'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import styles from '../tasks.module.css';
import {
  apiFetch,
  initLiff,
  reconnectLiff,
  resetLiff,
  saveTaskToCalendar,
  type LiffState,
} from '../../../../lib/liff';
import {
  AvatarStack,
  DeadlineChip,
  IconCalendar,
  IconCheck,
  IconClose,
  ListSkeleton,
  MemberRow,
  StateNotice,
} from '../components';

interface AssigneeDto {
  id: string;
  lineUid: string;
  displayName: string | null;
  pictureUrl: string | null;
  acceptedAt: string | null;
  doneAt: string | null;
  doneNote: string | null;
}

interface ItemDto {
  id: string;
  title: string;
  description: string | null;
  deadline: string | null;
  status: string;
  assignees: AssigneeDto[];
}

interface LinkDto {
  id: string;
  url: string;
  label: string | null;
}

interface TaskDto {
  id: string;
  groupLineId: string;
  title: string;
  type: string;
  status: string;
  globalDeadline: string | null;
  createdByLineUid: string;
  items: ItemDto[];
  links: LinkDto[];
}

interface GroupMemberDto {
  lineUid: string;
  displayName: string | null;
  pictureUrl: string | null;
}

const STATUS_BADGE: Record<string, { label: string; bg: string; fg: string }> = {
  pending: { label: 'รอดำเนินการ', bg: '#f3f4f6', fg: '#374151' },
  in_progress: { label: 'กำลังทำ', bg: '#fef3c7', fg: '#b45309' },
  done: { label: 'เสร็จแล้ว', bg: '#d1fae5', fg: '#047857' },
  cancelled: { label: 'ยกเลิก', bg: '#fee2e2', fg: '#b91c1c' },
};

/** ISO → 'YYYY-MM-DDTHH:mm' local, for <input type="datetime-local">. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

const api = (taskId: string, path = '') => `/api-proxy/tasks/${encodeURIComponent(taskId)}${path}`;

/** Identical box geometry for both edit-sheet fields so ชื่องาน and กำหนดส่ง
 *  render exactly the same size (native datetime inputs otherwise size to their
 *  own intrinsic content). */
const EDIT_FIELD_BOX: CSSProperties = {
  width: '100%',
  height: 48,
  minHeight: 48,
  maxHeight: 48,
  boxSizing: 'border-box',
};

export default function TaskViewPage({ params }: { params: { taskId: string } }) {
  const [task, setTask] = useState<TaskDto | null>(null);
  const [viewerUid, setViewerUid] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'forbidden' | 'unauth' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // per-item note drafts + editing flags
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});
  const [noteEditing, setNoteEditing] = useState<Record<string, boolean>>({});
  // link add form
  const [addingLink, setAddingLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkLabel, setLinkLabel] = useState('');
  // edit sheet
  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDeadline, setEditDeadline] = useState('');
  // assignee sheet
  const [assigneeItemId, setAssigneeItemId] = useState<string | null>(null);
  const [roster, setRoster] = useState<GroupMemberDto[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  function showToast(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3200);
  }

  const applyAuthError = useCallback((s: LiffState): boolean => {
    if (s.authed) return true;
    setState(s.authError === 'network' ? 'error' : 'unauth');
    return false;
  }, []);

  const fetchTask = useCallback(async (): Promise<void> => {
    const res = await apiFetch(api(params.taskId)).catch(() => null);
    if (!res) return setState('error');
    if (res.status === 401) return setState('unauth');
    if (res.status === 403) return setState('forbidden');
    if (!res.ok) return setState('error');
    const body = (await res.json()) as { task: TaskDto; viewerLineUid: string };
    setTask(body.task);
    setViewerUid(body.viewerLineUid);
    setState('ready');
  }, [params.taskId]);

  useEffect(() => {
    initLiff()
      .then((s) => {
        if (applyAuthError(s)) return fetchTask();
      })
      .catch(() => setState('error'));
  }, [fetchTask, applyAuthError]);

  const retry = () => {
    setState('loading');
    resetLiff()
      .then((s) => {
        if (applyAuthError(s)) return fetchTask();
      })
      .catch(() => setState('error'));
  };

  const reconnect = () => {
    setState('loading');
    reconnectLiff()
      .then((s) => {
        if (applyAuthError(s)) return fetchTask();
      })
      .catch(() => setState('error'));
  };

  /**
   * Run a mutating call that returns { task }. Adopts the returned task and
   * surfaces a friendly toast on failure. Returns true on success.
   */
  async function mutate(
    path: string,
    init: RequestInit,
    okMsg?: string,
    errMsg = 'ทำรายการไม่สำเร็จ ลองใหม่อีกทีน้า',
  ): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    try {
      const res = await apiFetch(api(params.taskId, path), {
        headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
        ...init,
      });
      if (res.status === 401) {
        setState('unauth');
        return false;
      }
      if (!res.ok) {
        showToast(errMsg);
        return false;
      }
      const body = (await res.json()) as { task: TaskDto };
      setTask(body.task);
      if (okMsg) showToast(okMsg);
      return true;
    } catch {
      showToast(errMsg);
      return false;
    } finally {
      setBusy(false);
    }
  }

  // ---- states ----
  if (state === 'loading') {
    return (
      <main className={styles.page}>
        <header className={styles.header}>
          <div className={styles.skeletonBar} style={{ width: '60%', height: 20, marginBottom: 10 }} />
          <div className={styles.skeletonBar} style={{ width: '35%' }} />
        </header>
        <ListSkeleton rows={4} />
      </main>
    );
  }
  if (state === 'forbidden') {
    return (
      <main className={styles.page}>
        <StateNotice
          title="งานนี้เป็นของกลุ่มที่เรายังไม่ได้อยู่ด้วยน้า"
          body="ลองส่งข้อความในกลุ่มนั้นสักครั้ง แล้วกดลองใหม่อีกทีน้า"
          onRetry={retry}
        />
      </main>
    );
  }
  if (state === 'unauth') {
    return (
      <main className={styles.page}>
        <StateNotice
          title="ต้องเชื่อมต่อ LINE ก่อนน้า"
          body="กด 'เชื่อมต่ออีกครั้ง' เพื่อเข้าสู่ระบบด้วย LINE ใหม่น้า ถ้ายังไม่ได้ ลองปิดหน้านี้แล้วเปิดใหม่จากปุ่มในห้องแชทอีกที"
          onRetry={reconnect}
          retryLabel="เชื่อมต่ออีกครั้ง"
        />
      </main>
    );
  }
  if (state === 'error' || !task) {
    return (
      <main className={styles.page}>
        <StateNotice
          title="โหลดงานไม่สำเร็จน้า"
          body="เช็คสัญญาณอินเทอร์เน็ตแล้วลองใหม่อีกทีน้า"
          onRetry={retry}
        />
      </main>
    );
  }

  const badge = STATUS_BADGE[task.status] ?? STATUS_BADGE.pending!;
  const isCreator = task.createdByLineUid === viewerUid;
  const isRecurring = task.type === 'recurring';
  const isClosed = task.status === 'done' || task.status === 'cancelled';
  const calendarDeadline =
    task.globalDeadline ?? task.items.find((i) => i.deadline)?.deadline ?? null;
  const doneCount = task.items.filter((i) => i.status === 'done').length;
  const progress = task.items.length > 0 ? Math.round((doneCount / task.items.length) * 100) : 0;

  // ---- actions ----
  const doDone = async (item: ItemDto) => {
    const note = (noteDraft[item.id] ?? '').trim();
    const ok = await mutate(
      `/items/${item.id}/done`,
      { method: 'POST', body: JSON.stringify(note ? { note } : {}) },
      'บันทึกว่าเสร็จแล้วน้า',
    );
    if (ok) setNoteDraft((d) => ({ ...d, [item.id]: '' }));
  };
  const doAccept = (item: ItemDto) =>
    mutate(`/items/${item.id}/accept`, { method: 'POST' }, 'รับทราบแล้วน้า สู้ๆ น้า');
  const saveNote = async (item: ItemDto) => {
    const note = noteDraft[item.id] ?? '';
    const ok = await mutate(
      `/items/${item.id}/note`,
      { method: 'PATCH', body: JSON.stringify({ note }) },
      'แก้หมายเหตุแล้วน้า',
    );
    if (ok) setNoteEditing((e) => ({ ...e, [item.id]: false }));
  };
  const doAddLink = async () => {
    const url = linkUrl.trim();
    if (!url) return;
    const ok = await mutate(
      '/links',
      { method: 'POST', body: JSON.stringify(linkLabel.trim() ? { url, label: linkLabel.trim() } : { url }) },
      'แนบลิงก์แล้วน้า',
      'แนบลิงก์ไม่สำเร็จ — ต้องเป็นลิงก์ http/https ที่ถูกต้องน้า',
    );
    if (ok) {
      setLinkUrl('');
      setLinkLabel('');
      setAddingLink(false);
    }
  };
  const openEdit = () => {
    setEditTitle(task.title);
    setEditDeadline(toLocalInput(task.globalDeadline));
    setEditOpen(true);
  };
  const saveEdit = async () => {
    const patch: { title?: string; globalDeadline?: string } = {};
    if (editTitle.trim() && editTitle.trim() !== task.title) patch.title = editTitle.trim();
    if (!isRecurring && editDeadline) {
      const iso = new Date(editDeadline).toISOString();
      if (iso !== task.globalDeadline) patch.globalDeadline = iso;
    }
    if (Object.keys(patch).length === 0) return setEditOpen(false);
    const ok = await mutate('', { method: 'PATCH', body: JSON.stringify(patch) }, 'บันทึกการแก้ไขแล้วน้า');
    if (ok) setEditOpen(false);
  };
  const doCancel = async () => {
    if (!window.confirm(`ยกเลิกงาน "${task.title}" ใช่ไหมน้า? หนูจะหยุดเตือนและบอกกลุ่มให้`)) return;
    await mutate('', { method: 'DELETE' }, 'ยกเลิกงานแล้วน้า');
  };
  const openAssigneeEditor = async (item: ItemDto) => {
    setAssigneeItemId(item.id);
    setPicked(new Set(item.assignees.map((a) => a.lineUid)));
    setRoster(null);
    const res = await apiFetch(`/api-proxy/groups/${encodeURIComponent(task.groupLineId)}/members`).catch(
      () => null,
    );
    if (res && res.ok) {
      const body = (await res.json()) as { members: GroupMemberDto[] };
      setRoster(body.members);
    } else {
      setRoster([]);
      showToast('โหลดรายชื่อสมาชิกไม่สำเร็จน้า');
    }
  };
  const saveAssignees = async () => {
    if (!assigneeItemId) return;
    if (picked.size === 0) return showToast('ต้องมีผู้รับผิดชอบอย่างน้อย 1 คนน้า');
    const ok = await mutate(
      `/items/${assigneeItemId}/assignees`,
      { method: 'PUT', body: JSON.stringify({ lineUids: [...picked] }) },
      'แก้ผู้รับผิดชอบแล้วน้า',
    );
    if (ok) setAssigneeItemId(null);
  };

  return (
    <main className={styles.page} style={{ paddingBottom: 60 }}>
      <header className={styles.header}>
        <div className={styles.headerRow}>
          <h1 className={styles.headerTitle}>{task.title}</h1>
          <span className={styles.statusBadge} style={{ background: badge.bg, color: badge.fg }}>
            {badge.label}
          </span>
        </div>
        {task.globalDeadline && (
          <p className={styles.headerSub}>
            <DeadlineChip iso={task.globalDeadline} />
          </p>
        )}
        {isCreator && !isClosed && (
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button type="button" className={styles.ghostBtn} onClick={openEdit} disabled={busy}>
              แก้ไขงาน
            </button>
            <button
              type="button"
              className={styles.ghostBtn}
              style={{ color: '#b91c1c' }}
              onClick={() => void doCancel()}
              disabled={busy}
            >
              ยกเลิกงาน
            </button>
          </div>
        )}
      </header>

      <section className={styles.section} style={{ paddingTop: 0 }}>
        <div className={styles.card}>
          <div className={styles.headerRow} style={{ marginBottom: 8 }}>
            <span className={styles.fieldLabel} style={{ margin: 0 }}>
              ความคืบหน้า
            </span>
            <span className={styles.fieldLabel} style={{ margin: 0 }}>
              {doneCount}/{task.items.length}
            </span>
          </div>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${progress}%` }} />
          </div>
        </div>
      </section>

      {/* links */}
      <section className={styles.section}>
        <div className={styles.headerRow} style={{ marginBottom: 8 }}>
          <p className={styles.sectionLabel} style={{ margin: 0 }}>
            ลิงก์ที่แนบ
          </p>
          {isCreator && !isClosed && !addingLink && (
            <button type="button" className={styles.ghostBtn} style={{ padding: 4 }} onClick={() => setAddingLink(true)}>
              เพิ่มลิงก์
            </button>
          )}
        </div>
        {task.links.length === 0 && !addingLink && (
          <p className={styles.typeSub} style={{ margin: 0 }}>
            ยังไม่มีลิงก์แนบน้า
          </p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {task.links.map((link) => (
            <div key={link.id} className={styles.card} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12 }}>
              <a
                href={link.url}
                target="_blank"
                rel="noreferrer"
                style={{ flex: 1, minWidth: 0, color: '#1971c2', fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {link.label || link.url}
              </a>
              {isCreator && !isClosed && (
                <button
                  type="button"
                  aria-label="ลบลิงก์"
                  onClick={() => void mutate(`/links/${link.id}`, { method: 'DELETE' }, 'ลบลิงก์แล้วน้า')}
                  disabled={busy}
                  style={{ border: 'none', background: 'none', color: '#b0b0b0', cursor: 'pointer', padding: 4 }}
                >
                  <IconClose size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
        {addingLink && (
          <div className={styles.card} style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
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
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" className={styles.doneBtn} onClick={() => void doAddLink()} disabled={busy}>
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
        <p className={styles.sectionLabel}>รายการงาน</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {task.items.map((item, i) => {
            const mine = viewerUid ? item.assignees.find((a) => a.lineUid === viewerUid) : undefined;
            const myDone = mine?.doneAt != null;
            const itemDone = item.status === 'done';
            return (
              <div key={item.id} className={styles.itemCard} style={{ flexDirection: 'column' }}>
                <div style={{ display: 'flex', gap: 12, width: '100%' }}>
                  <span className={styles.numBadge} style={itemDone ? { background: '#059669' } : undefined}>
                    {itemDone ? <IconCheck size={13} /> : i + 1}
                  </span>
                  <div className={styles.itemBody}>
                    <p className={styles.itemTitle}>{item.title}</p>
                    {item.description && (
                      <p className={styles.typeSub} style={{ marginBottom: 6 }}>
                        {item.description}
                      </p>
                    )}
                    <div className={styles.itemMeta}>
                      <AvatarStack members={item.assignees} size={24} max={4} />
                      <DeadlineChip iso={item.deadline} />
                    </div>
                  </div>
                  {isCreator && !isClosed && (
                    <button
                      type="button"
                      className={styles.ghostBtn}
                      style={{ padding: 4, minHeight: 0, fontSize: 13 }}
                      onClick={() => void openAssigneeEditor(item)}
                    >
                      แก้คน
                    </button>
                  )}
                </div>

                {/* per-assignee status + notes */}
                <div style={{ marginTop: 10, width: '100%' }}>
                  {item.assignees.map((a) => {
                    const s = a.doneAt
                      ? { txt: 'เสร็จแล้ว', c: '#059669' }
                      : a.acceptedAt
                        ? { txt: 'รับทราบแล้ว', c: '#1971c2' }
                        : { txt: 'ยังไม่เสร็จ', c: '#8c8c8c' };
                    return (
                      <div key={a.id}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                          <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: '#333' }}>
                            {a.displayName || 'สมาชิก'}
                          </span>
                          <span style={{ fontSize: 12, fontWeight: 600, color: s.c }}>{s.txt}</span>
                        </div>
                        {a.doneNote && (
                          <p
                            style={{
                              fontSize: 12,
                              color: '#555',
                              background: '#f7f7f7',
                              borderLeft: '3px solid #b53a3255',
                              borderRadius: 6,
                              padding: '6px 10px',
                              margin: '2px 0 4px',
                              whiteSpace: 'pre-wrap',
                            }}
                          >
                            {a.doneNote}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* viewer controls */}
                {mine && !isClosed && !myDone && (
                  <div style={{ marginTop: 10, width: '100%' }}>
                    <textarea
                      className={styles.textarea}
                      style={{ minHeight: 60 }}
                      placeholder="หมายเหตุ (ไม่ใส่ก็ได้) เช่น ส่งไฟล์ในกลุ่มแล้ว"
                      value={noteDraft[item.id] ?? ''}
                      onChange={(e) => setNoteDraft((d) => ({ ...d, [item.id]: e.target.value }))}
                      maxLength={500}
                    />
                    <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                      <button type="button" className={styles.doneBtn} onClick={() => void doDone(item)} disabled={busy}>
                        เสร็จแล้ว
                      </button>
                      {!mine.acceptedAt && (
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

                {mine && !isClosed && myDone && (
                  <div style={{ marginTop: 8, width: '100%' }}>
                    {noteEditing[item.id] ? (
                      <>
                        <textarea
                          className={styles.textarea}
                          style={{ minHeight: 60 }}
                          value={noteDraft[item.id] ?? mine.doneNote ?? ''}
                          onChange={(e) => setNoteDraft((d) => ({ ...d, [item.id]: e.target.value }))}
                          maxLength={500}
                        />
                        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                          <button type="button" className={styles.doneBtn} onClick={() => void saveNote(item)} disabled={busy}>
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
                          setNoteDraft((d) => ({ ...d, [item.id]: mine.doneNote ?? '' }));
                          setNoteEditing((e) => ({ ...e, [item.id]: true }));
                        }}
                      >
                        {mine.doneNote ? 'แก้หมายเหตุของฉัน' : 'เพิ่มหมายเหตุ'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {calendarDeadline && (
        <section className={styles.section}>
          <button
            type="button"
            className={styles.secondaryBtn}
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
            onClick={async () => {
              await saveTaskToCalendar(task.id, task.title, calendarDeadline);
            }}
          >
            <IconCalendar /> บันทึกลงปฏิทิน
          </button>
        </section>
      )}

      {/* edit sheet */}
      {editOpen && (
        <div className={styles.sheetOverlay} onClick={() => setEditOpen(false)}>
          <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
            <div className={styles.sheetHandle} />
            <label className={styles.fieldLabel}>ชื่องาน</label>
            <input
              className={styles.input}
              style={EDIT_FIELD_BOX}
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              maxLength={200}
            />
            {!isRecurring ? (
              <>
                <label className={styles.fieldLabel} style={{ marginTop: 12 }}>
                  กำหนดส่ง
                </label>
                {/* The global `.input[type=datetime-local]` rule strips the
                    border/background because the box is meant to come from the
                    dateInputWrap wrapper — whose overflow:hidden also clips the
                    native control so it can never render wider than the ชื่องาน
                    box above (EDIT_FIELD_BOX gives both the identical geometry). */}
                <div className={styles.dateInputWrap} style={EDIT_FIELD_BOX}>
                  <input
                    className={styles.input}
                    type="datetime-local"
                    style={{ width: '100%', height: '100%' }}
                    value={editDeadline}
                    onChange={(e) => setEditDeadline(e.target.value)}
                  />
                </div>
              </>
            ) : (
              <p className={styles.typeSub} style={{ marginTop: 10 }}>
                งานประจำเลื่อนรอบเองตามกำหนด แก้กำหนดส่งไม่ได้น้า
              </p>
            )}
            <button type="button" className={styles.primaryBtn} style={{ marginTop: 16 }} onClick={() => void saveEdit()} disabled={busy}>
              บันทึก
            </button>
          </div>
        </div>
      )}

      {/* assignee editor sheet */}
      {assigneeItemId && (
        <div className={styles.sheetOverlay} onClick={() => setAssigneeItemId(null)}>
          <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
            <div className={styles.sheetHandle} />
            <p className={styles.sectionLabel}>เลือกผู้รับผิดชอบ</p>
            {roster === null ? (
              <ListSkeleton rows={4} />
            ) : roster.length === 0 ? (
              <p className={styles.typeSub}>ยังไม่มีสมาชิกในกลุ่มให้เลือกน้า ลองให้เพื่อนส่งข้อความในกลุ่มก่อน</p>
            ) : (
              <div className={styles.memberList}>
                {roster.map((m) => (
                  <MemberRow
                    key={m.lineUid}
                    member={m}
                    selected={picked.has(m.lineUid)}
                    onToggle={() =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (next.has(m.lineUid)) next.delete(m.lineUid);
                        else next.add(m.lineUid);
                        return next;
                      })
                    }
                  />
                ))}
              </div>
            )}
            <button
              type="button"
              className={styles.primaryBtn}
              style={{ marginTop: 16 }}
              onClick={() => void saveAssignees()}
              disabled={busy || picked.size === 0}
            >
              บันทึก
            </button>
          </div>
        </div>
      )}

      {toast && <div className={styles.errorBox} style={{ position: 'fixed', left: 20, right: 20, bottom: 20 }}>{toast}</div>}
    </main>
  );
}
