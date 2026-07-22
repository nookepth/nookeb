'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from '../../tasks.module.css';
import { apiFetch, initLiff, reconnectLiff, resetLiff, type LiffState } from '../../../../../lib/liff';
import { DeadlineChip, ListSkeleton, StateNotice } from '../../components';
import { FileAttach } from '../../FileAttach';
import { describeRejection, uploadTaskFiles } from '../../../../../lib/taskFiles';

/**
 * ส่งงานกลับ — the assignee's submit screen (migration 045).
 *
 * Order of operations matters: files are uploaded FIRST, then the submit call
 * flips the item to 'submitted'. That way the creator never sees "รอตรวจ" on an
 * item whose evidence is still in flight (or never arrived). A failed upload
 * leaves the item untouched, so the user can simply try again.
 *
 * ?item=<uuid> picks which item is being submitted. Omitted → the only item the
 * viewer owns; if they own several, the page asks them to choose.
 */

interface AssigneeDto {
  lineUid: string;
  displayName: string | null;
}
interface ItemDto {
  id: string;
  title: string;
  deadline: string | null;
  status: string;
  rejectionNote: string | null;
  assignees: AssigneeDto[];
}
interface TaskDto {
  id: string;
  title: string;
  type: string;
  status: string;
  globalDeadline: string | null;
  items: ItemDto[];
}

/**
 * ?item= read straight off the URL rather than via useSearchParams(): the hook
 * forces every page containing it into a Suspense boundary at build time, and
 * the rest of the LIFF flow already reads its query this way (lib/liff.ts,
 * lib/taskDraft.ts).
 */
function queryItemId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get('item');
  } catch {
    return null;
  }
}

export default function SubmitTaskPage({ params }: { params: { taskId: string } }) {
  const router = useRouter();
  const [task, setTask] = useState<TaskDto | null>(null);
  const [viewerUid, setViewerUid] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'forbidden' | 'unauth' | 'error'>('loading');
  const [itemId, setItemId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const api = (path = '') => `/api-proxy/tasks/${encodeURIComponent(params.taskId)}${path}`;

  const applyAuthError = useCallback((s: LiffState): boolean => {
    if (s.authed) return true;
    setState(s.authError === 'network' ? 'error' : 'unauth');
    return false;
  }, []);

  const fetchTask = useCallback(async (): Promise<void> => {
    const res = await apiFetch(api()).catch(() => null);
    if (!res) return setState('error');
    if (res.status === 401) return setState('unauth');
    if (res.status === 403) return setState('forbidden');
    if (!res.ok) return setState('error');
    const body = (await res.json()) as { task: TaskDto; viewerLineUid: string };
    setTask(body.task);
    setViewerUid(body.viewerLineUid);

    // Preselect: ?item= when it's genuinely the viewer's, else the single item
    // they own. Never guess when they own more than one.
    const mine = body.task.items.filter(
      (i) =>
        i.assignees.some((a) => a.lineUid === body.viewerLineUid) &&
        i.status !== 'done' &&
        i.status !== 'cancelled',
    );
    const wanted = queryItemId();
    setItemId(mine.find((i) => i.id === wanted)?.id ?? (mine.length === 1 ? mine[0]!.id : null));
    setState('ready');
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const submit = async () => {
    if (!itemId || busy) return;
    setError(null);
    setBusy(true);
    try {
      // 1) files first — see the header note on ordering.
      if (files.length > 0) {
        setProgress({ done: 0, total: files.length });
        const result = await uploadTaskFiles(params.taskId, files, {
          itemId,
          kind: 'submission',
          onProgress: (d, t) => setProgress({ done: d, total: t }),
        });
        setProgress(null);
        if (result.rejected.length > 0) {
          setError(
            `แนบไฟล์ไม่สำเร็จ — ${result.rejected.map(describeRejection).join(' · ')} · แก้แล้วลองส่งใหม่น้า`,
          );
          return;
        }
        setFiles([]);
      }

      // 2) optional reference link (reuses the task-level links endpoint).
      const url = linkUrl.trim();
      if (url) {
        const linkRes = await apiFetch(api('/links'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        if (!linkRes.ok) {
          // Only the creator may attach task-level links, so an assignee's link
          // is best-effort: fold it into the note rather than blocking the submit.
          setNote((n) => (n.includes(url) ? n : `${n ? `${n}\n` : ''}ลิงก์งาน: ${url}`));
        }
        setLinkUrl('');
      }

      // 3) flip the item to 'submitted'.
      const res = await apiFetch(api(`/items/${itemId}/submit`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(note.trim() ? { note: note.trim() } : {}),
      });
      if (res.status === 401) return setState('unauth');
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'ส่งงานกลับไม่สำเร็จ ลองใหม่อีกทีน้า');
        return;
      }
      setDone(true);
    } catch {
      setError('ส่งงานกลับไม่สำเร็จ ลองใหม่อีกทีน้า');
    } finally {
      setProgress(null);
      setBusy(false);
    }
  };

  // ---- states ----
  if (state === 'loading') {
    return (
      <main className={styles.page}>
        <header className={styles.header}>
          <div className={styles.skeletonBar} style={{ width: '55%', height: 20 }} />
        </header>
        <ListSkeleton rows={3} />
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
                if (applyAuthError(s)) return fetchTask();
              })
              .catch(() => setState('error'));
          }}
          retryLabel="เชื่อมต่ออีกครั้ง"
        />
      </main>
    );
  }
  if (state === 'forbidden') {
    return (
      <main className={styles.page}>
        <StateNotice title="งานนี้ไม่ได้เกี่ยวกับเราน้า" body="ลองเปิดจากการ์ดงานในห้องแชทอีกที" onRetry={retry} />
      </main>
    );
  }
  if (state === 'error' || !task) {
    return (
      <main className={styles.page}>
        <StateNotice title="โหลดงานไม่สำเร็จน้า" body="เช็คสัญญาณอินเทอร์เน็ตแล้วลองใหม่อีกทีน้า" onRetry={retry} />
      </main>
    );
  }

  if (done) {
    return (
      <main className={styles.page}>
        <div className={styles.successWrap}>
          <h1 className={styles.headerTitle}>ส่งงานกลับแล้วน้า</h1>
          <p className={styles.headerSub}>รอคนสั่งงานตรวจอยู่น้า ถ้ามีอะไรให้แก้ หนูจะบอกให้</p>
        </div>
        <div className={styles.cardList}>
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={() => router.replace(`/liff/tasks/${params.taskId}`)}
          >
            กลับไปดูงาน
          </button>
        </div>
      </main>
    );
  }

  const myItems = task.items.filter(
    (i) =>
      i.assignees.some((a) => a.lineUid === viewerUid) &&
      i.status !== 'done' &&
      i.status !== 'cancelled',
  );
  const selected = myItems.find((i) => i.id === itemId) ?? null;

  if (myItems.length === 0) {
    return (
      <main className={styles.page}>
        <StateNotice
          title="ไม่มีข้อที่ต้องส่งแล้วน้า"
          body="งานที่มอบให้เราในงานนี้เสร็จหมดแล้ว หรือยังไม่ได้ถูกมอบหมายให้เราน้า"
          onRetry={() => router.replace(`/liff/tasks/${params.taskId}`)}
          retryLabel="กลับไปดูงาน"
        />
      </main>
    );
  }

  return (
    <main className={styles.page} style={{ paddingBottom: 100 }}>
      <div className={styles.heroHeader}>
        <button
          type="button"
          className={styles.ghostBtn}
          style={{ padding: 4, marginBottom: 6 }}
          onClick={() => router.push(`/liff/tasks/${params.taskId}`)}
        >
          ← กลับ
        </button>
        <p className={styles.heroLabel}>ส่งงานกลับ</p>
        <h1 className={styles.headerTitle} style={{ overflowWrap: 'anywhere' }}>
          {task.title}
        </h1>
        {(selected?.deadline ?? task.globalDeadline) && (
          <div style={{ marginTop: 10 }}>
            <DeadlineChip iso={selected?.deadline ?? task.globalDeadline} />
          </div>
        )}
      </div>

      {/* which item — only when the viewer owns more than one */}
      {myItems.length > 1 && (
        <section className={styles.section}>
          <p className={styles.sectionLabel}>ส่งข้อไหน</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {myItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={styles.card}
                style={{
                  textAlign: 'left',
                  cursor: 'pointer',
                  borderColor: item.id === itemId ? '#b53a32' : undefined,
                  borderWidth: item.id === itemId ? 2 : undefined,
                }}
                onClick={() => setItemId(item.id)}
              >
                <p style={{ margin: 0, fontSize: 14, color: '#333' }}>{item.title}</p>
                <DeadlineChip iso={item.deadline} />
              </button>
            ))}
          </div>
        </section>
      )}

      {selected?.status === 'rejected' && selected.rejectionNote && (
        <section className={styles.section}>
          <div
            className={styles.card}
            style={{ borderLeft: '4px solid #b91c1c', background: '#fef2f2' }}
          >
            <p className={styles.fieldLabel} style={{ margin: 0, color: '#b91c1c' }}>
              รอบก่อนถูกตีกลับ
            </p>
            <p style={{ margin: '6px 0 0', fontSize: 13, color: '#555', whiteSpace: 'pre-wrap' }}>
              {selected.rejectionNote}
            </p>
          </div>
        </section>
      )}

      <section className={styles.section}>
        <label className={styles.fieldLabel}>หมายเหตุ (ไม่บังคับ)</label>
        <textarea
          className={styles.textarea}
          style={{ minHeight: 90 }}
          placeholder="เช่น แก้ตามที่คุยไว้แล้ว เหลือหน้าสุดท้ายรอตรวจ"
          value={note}
          maxLength={1000}
          onChange={(e) => setNote(e.target.value)}
        />
      </section>

      <section className={styles.section}>
        <p className={styles.sectionLabel}>ไฟล์งาน (ไม่บังคับ)</p>
        <FileAttach files={files} onChange={setFiles} disabled={busy} progress={progress} />
      </section>

      <section className={styles.section}>
        <label className={styles.fieldLabel}>หรือวางลิงก์งาน</label>
        <input
          className={styles.input}
          placeholder="https://…"
          inputMode="url"
          value={linkUrl}
          onChange={(e) => setLinkUrl(e.target.value)}
        />
      </section>

      {error && <div className={styles.errorBox}>{error}</div>}

      <div className={styles.stickyFooter}>
        <button
          type="button"
          className={styles.primaryBtn}
          style={{ width: '100%' }}
          disabled={busy || !itemId}
          onClick={() => void submit()}
        >
          {progress
            ? `กำลังแนบไฟล์ ${progress.done}/${progress.total}...`
            : busy
              ? 'กำลังส่ง...'
              : 'ส่งงานกลับ →'}
        </button>
      </div>
    </main>
  );
}
