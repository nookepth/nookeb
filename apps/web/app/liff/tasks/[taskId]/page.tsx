'use client';

import { useCallback, useEffect, useState } from 'react';
import styles from '../tasks.module.css';
import { initLiff } from '../../../../lib/liff';
import { AvatarStack, DeadlineChip, ListSkeleton } from '../components';

interface AssigneeDto {
  id: string;
  lineUid: string;
  displayName: string | null;
  pictureUrl: string | null;
  doneAt: string | null;
}

interface ItemDto {
  id: string;
  title: string;
  description: string | null;
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
  items: ItemDto[];
}

const STATUS_BADGE: Record<string, { label: string; bg: string; fg: string }> = {
  pending: { label: 'รอดำเนินการ', bg: '#f3f4f6', fg: '#374151' },
  in_progress: { label: 'กำลังทำ', bg: '#fef3c7', fg: '#b45309' },
  done: { label: 'เสร็จแล้ว', bg: '#d1fae5', fg: '#047857' },
  cancelled: { label: 'ยกเลิก', bg: '#fee2e2', fg: '#b91c1c' },
};

export default function TaskViewPage({ params }: { params: { taskId: string } }) {
  const [task, setTask] = useState<TaskDto | null>(null);
  const [viewerUid, setViewerUid] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'forbidden' | 'error'>('loading');
  const [marking, setMarking] = useState<string | null>(null); // itemId in flight
  const [toast, setToast] = useState<string | null>(null);

  const fetchTask = useCallback(async (): Promise<void> => {
    const res = await fetch(`/api-proxy/tasks/${encodeURIComponent(params.taskId)}`);
    if (res.status === 403) {
      setState('forbidden');
      return;
    }
    if (!res.ok) {
      setState('error');
      return;
    }
    const body = (await res.json()) as { task: TaskDto; viewerLineUid: string };
    setTask(body.task);
    setViewerUid(body.viewerLineUid);
    setState('ready');
  }, [params.taskId]);

  useEffect(() => {
    initLiff()
      .then(() => fetchTask())
      .catch(() => setState('error'));
  }, [fetchTask]);

  const markDone = async (item: ItemDto) => {
    if (!task || !viewerUid || marking) return;
    setMarking(item.id);

    // Optimistic: flip my done mark instantly, roll back if the API rejects.
    const before = task;
    setTask({
      ...task,
      items: task.items.map((i) =>
        i.id === item.id
          ? {
              ...i,
              assignees: i.assignees.map((a) =>
                a.lineUid === viewerUid ? { ...a, doneAt: new Date().toISOString() } : a,
              ),
            }
          : i,
      ),
    });

    try {
      const res = await fetch(
        `/api-proxy/tasks/${encodeURIComponent(task.id)}/items/${encodeURIComponent(item.id)}/done`,
        { method: 'POST' },
      );
      if (!res.ok) {
        setTask(before);
        setToast('บันทึกไม่สำเร็จ ลองใหม่อีกทีน้า');
        return;
      }
      // Server truth (item/task status rollup) replaces the optimistic guess.
      const body = (await res.json()) as { task: TaskDto };
      setTask(body.task);
      setToast(null);
    } catch {
      setTask(before);
      setToast('บันทึกไม่สำเร็จ ลองใหม่อีกทีน้า');
    } finally {
      setMarking(null);
    }
  };

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
        <div className={styles.errorBox}>
          งานนี้เป็นของกลุ่มที่เรายังไม่ได้ลงทะเบียนน้า — พิมพ์ /register ในกลุ่มนั้นก่อน แล้วเปิดใหม่อีกที
        </div>
      </main>
    );
  }

  if (state === 'error' || !task) {
    return (
      <main className={styles.page}>
        <div className={styles.errorBox}>โหลดงานไม่สำเร็จ ลองปิดแล้วเปิดใหม่อีกทีน้า</div>
      </main>
    );
  }

  const badge = STATUS_BADGE[task.status] ?? STATUS_BADGE.pending!;
  const doneCount = task.items.filter((i) => i.status === 'done').length;
  const progress = task.items.length > 0 ? Math.round((doneCount / task.items.length) * 100) : 0;

  return (
    <main className={styles.page} style={{ paddingBottom: 40 }}>
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

      <section className={styles.section}>
        <p className={styles.sectionLabel}>รายการงาน</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {task.items.map((item, i) => {
            const mine = viewerUid
              ? item.assignees.find((a) => a.lineUid === viewerUid)
              : undefined;
            const myDone = mine?.doneAt != null;
            const itemDone = item.status === 'done';
            return (
              <div key={item.id} className={styles.itemCard}>
                <span
                  className={styles.numBadge}
                  style={itemDone ? { background: '#059669' } : undefined}
                >
                  {itemDone ? '✓' : i + 1}
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
                    <span className={styles.typeSub}>
                      เสร็จ {item.assignees.filter((a) => a.doneAt).length}/{item.assignees.length}
                    </span>
                  </div>
                </div>
                {mine &&
                  (myDone ? (
                    <span className={styles.doneMark}>✓ เสร็จแล้ว</span>
                  ) : (
                    <button
                      type="button"
                      className={styles.doneBtn}
                      disabled={marking === item.id}
                      onClick={() => void markDone(item)}
                    >
                      เสร็จแล้ว
                    </button>
                  ))}
              </div>
            );
          })}
        </div>
      </section>

      <section className={styles.section}>
        <a
          className={styles.secondaryBtn}
          style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}
          href={`/api-proxy/tasks/${encodeURIComponent(task.id)}/ics`}
        >
          📅 บันทึกลงปฏิทิน
        </a>
      </section>

      {toast && <div className={styles.errorBox}>{toast}</div>}
    </main>
  );
}
