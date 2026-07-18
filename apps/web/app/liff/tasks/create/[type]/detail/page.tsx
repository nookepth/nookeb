'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from '../../../tasks.module.css';
import { apiFetch, closeLiff, initLiff, saveTaskToCalendar } from '../../../../../../lib/liff';
import {
  clearDraft,
  loadDraft,
  localToIso,
  saveDraft,
  type TaskDraft,
} from '../../../../../../lib/taskDraft';
import { AvatarStack, DeadlineChip, IconCalendar, IconCheck } from '../../../components';

interface CreatedTask {
  id: string;
  /** false when the group announcement push failed (e.g. push quota) — the
   * task IS saved + scheduled, but the card never reached the group, so the
   * success screen must not claim otherwise. */
  announced: boolean;
}

const WEEKDAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัส', 'ศุกร์', 'เสาร์'];

export default function DetailPage({ params }: { params: { type: string } }) {
  const router = useRouter();
  const [draft, setDraftState] = useState<TaskDraft | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetTitle, setSheetTitle] = useState('');
  const [sheetDeadline, setSheetDeadline] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreatedTask | null>(null);

  // Update state + sessionStorage together (LIFF may reload at any navigation).
  const setDraft = (next: TaskDraft) => {
    setDraftState(next);
    saveDraft(next);
  };

  useEffect(() => {
    const stored = loadDraft();
    if (!stored?.groupId) {
      router.replace('/liff/tasks/create');
      return;
    }
    setDraftState(stored);
    // Returning from the member step with a staged item → reopen the sheet
    // prefilled so the user confirms the item with its fresh selection.
    if (stored.pendingItem) {
      setSheetTitle(stored.pendingItem.title);
      setSheetDeadline(stored.pendingItem.deadline ?? '');
      setSheetOpen(true);
    }
    void initLiff().catch(() => {});
  }, [router]);

  if (!draft) return <main className={styles.page} />;

  const isMulti = draft.type === 'multi';
  const isRecurring = draft.type === 'recurring';

  // ---- multi: bottom sheet actions ----

  const openSheet = () => {
    setSheetTitle('');
    setSheetDeadline('');
    setSheetOpen(true);
  };

  const goPickMembers = () => {
    // Stage the sheet's fields so they survive the round-trip to the member step.
    setDraft({ ...draft, pendingItem: { title: sheetTitle, deadline: sheetDeadline || null } });
    router.push(`/liff/tasks/create/${params.type}/members`);
  };

  const addItem = () => {
    if (!sheetTitle.trim()) {
      setError('ตั้งชื่อรายการก่อนน้า');
      return;
    }
    if (draft.selected.length === 0) {
      setError('เลือกคนรับผิดชอบให้รายการนี้ก่อนน้า');
      return;
    }
    setError(null);
    setDraft({
      ...draft,
      items: [
        ...draft.items,
        {
          title: sheetTitle.trim(),
          description: null,
          deadline: sheetDeadline || null,
          assignees: draft.selected,
        },
      ],
      pendingItem: null,
    });
    setSheetOpen(false);
  };

  const removeItem = (index: number) => {
    setDraft({ ...draft, items: draft.items.filter((_, i) => i !== index) });
  };

  // ---- validation + submit ----

  const validate = (): string | null => {
    if (!draft.title.trim()) return 'ตั้งชื่องานก่อนน้า';
    if (draft.type === 'single') {
      if (!draft.globalDeadline) return 'เลือก deadline ก่อนน้า';
      if (new Date(draft.globalDeadline).getTime() <= Date.now())
        return 'deadline ต้องอยู่ในอนาคตน้า';
      if (draft.selected.length === 0) return 'ต้องมีคนรับผิดชอบอย่างน้อย 1 คนน้า';
    }
    if (draft.type === 'multi') {
      if (draft.items.length === 0) return 'เพิ่มรายการงานอย่างน้อย 1 ข้อก่อนน้า';
      const missingDeadline = draft.items.some((i) => !i.deadline) && !draft.globalDeadline;
      if (missingDeadline) return 'มีข้อที่ยังไม่มี deadline — ใส่ deadline รวมของงาน หรือใส่รายข้อน้า';
      for (const item of draft.items) {
        const eff = item.deadline ?? draft.globalDeadline!;
        if (new Date(eff).getTime() <= Date.now()) return `deadline ของ "${item.title}" ต้องอยู่ในอนาคตน้า`;
      }
    }
    if (draft.type === 'recurring' && draft.selected.length === 0)
      return 'ต้องมีคนรับผิดชอบอย่างน้อย 1 คนน้า';
    return null;
  };

  const submit = async () => {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const base = {
        groupId: draft.groupId!,
        title: draft.title.trim(),
        type: draft.type,
      };
      const payload =
        draft.type === 'multi'
          ? {
              ...base,
              ...(draft.globalDeadline ? { globalDeadline: localToIso(draft.globalDeadline) } : {}),
              items: draft.items.map((item) => ({
                title: item.title,
                ...(item.description ? { description: item.description } : {}),
                ...(item.deadline ? { deadline: localToIso(item.deadline) } : {}),
                assignees: item.assignees.map((a) => a.lineUid),
              })),
            }
          : draft.type === 'recurring'
            ? {
                ...base,
                recurrenceRule: {
                  freq: draft.recurrence.freq,
                  ...(draft.recurrence.freq === 'monthly' ? { day: draft.recurrence.day } : {}),
                  ...(draft.recurrence.freq === 'weekly' ? { weekday: draft.recurrence.weekday } : {}),
                  time: draft.recurrence.time,
                },
                items: [
                  {
                    title: draft.title.trim(),
                    ...(draft.description ? { description: draft.description } : {}),
                    assignees: draft.selected.map((a) => a.lineUid),
                  },
                ],
              }
            : {
                ...base,
                globalDeadline: localToIso(draft.globalDeadline!),
                items: [
                  {
                    title: draft.title.trim(),
                    ...(draft.description ? { description: draft.description } : {}),
                    assignees: draft.selected.map((a) => a.lineUid),
                  },
                ],
              };

      const res = await apiFetch('/api-proxy/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) {
        setError('เชื่อมต่อ LINE ไม่สำเร็จ ลองปิดแล้วเปิดใหม่จากปุ่มในกลุ่มอีกทีน้า');
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'ส่งงานไม่สำเร็จ ลองใหม่อีกทีน้า');
        return;
      }
      const body = (await res.json()) as { task: { id: string }; announced?: boolean };
      clearDraft();
      setCreated({ id: body.task.id, announced: body.announced !== false });
    } catch {
      setError('ส่งงานไม่สำเร็จ ลองใหม่อีกทีน้า');
    } finally {
      setSubmitting(false);
    }
  };

  // ---- success screen ----

  if (created) {
    // Calendar export needs one instant. single/multi carry a datetime-local
    // deadline (task-level, else the first item's); recurring has none → the
    // button is omitted rather than exporting a bogus 1970 event.
    const localDeadline =
      draft.globalDeadline ?? draft.items.find((i) => i.deadline)?.deadline ?? null;
    const calendarDeadline = localDeadline ? localToIso(localDeadline) : null;
    return (
      <main className={styles.page}>
        <div className={styles.successWrap}>
          <div className={styles.successCircle} aria-hidden>
            <IconCheck size={32} />
          </div>
          {created.announced ? (
            <>
              <h1 className={styles.headerTitle}>ส่งงานเข้ากลุ่มแล้วน้า</h1>
              <p className={styles.headerSub}>หนูเก็บจะช่วยตามงานให้เองทุกช่วงก่อนถึงกำหนด</p>
            </>
          ) : (
            <>
              <h1 className={styles.headerTitle}>บันทึกงานแล้วน้า</h1>
              <p className={styles.headerSub}>
                หนูตั้งเตือนให้เรียบร้อย แต่ส่งการ์ดเข้ากลุ่มไม่สำเร็จ (โควตาข้อความอาจเต็ม)
                — เปิดดูงานหรือแชร์ลิงก์ให้เพื่อนได้จากปุ่ม &quot;ดูงาน&quot; ด้านล่างน้า
              </p>
            </>
          )}
        </div>
        <div className={styles.cardList}>
          {!created.announced && (
            <a
              className={styles.secondaryBtn}
              style={{
                textDecoration: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
              href={`/liff/tasks/${created.id}`}
            >
              ดูงาน
            </a>
          )}
          {calendarDeadline && (
            <button
              type="button"
              className={styles.secondaryBtn}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
              onClick={() => void saveTaskToCalendar(draft.title.trim(), calendarDeadline)}
            >
              <IconCalendar /> บันทึกลงปฏิทิน
            </button>
          )}
          <button type="button" className={styles.primaryBtn} onClick={() => closeLiff()}>
            เสร็จแล้ว ปิดหน้านี้
          </button>
        </div>
      </main>
    );
  }

  // ---- form ----

  return (
    <main className={styles.page}>
      <div className={styles.heroHeader}>
        <p className={styles.heroLabel}>
          {isRecurring ? 'งานประจำ' : isMulti ? 'แยกงานเป็นรายการ' : 'งานเดียว มอบหลายคน'}
        </p>
        <input
          className={styles.titleInput}
          placeholder="ชื่องาน เช่น สรุปยอดประจำเดือน"
          value={draft.title}
          maxLength={200}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
      </div>

      {/* single */}
      {draft.type === 'single' && (
        <section className={styles.section}>
          <div className={styles.card}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Deadline</label>
              <input
                type="datetime-local"
                className={styles.input}
                style={{ width: '100%', height: 44, boxSizing: 'border-box' }}
                value={draft.globalDeadline ?? ''}
                onChange={(e) => setDraft({ ...draft, globalDeadline: e.target.value || null })}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>รายละเอียด (ไม่บังคับ)</label>
              <textarea
                className={styles.textarea}
                placeholder="อธิบายงานเพิ่มเติม..."
                value={draft.description}
                maxLength={1000}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </div>
            <label className={styles.fieldLabel}>คนรับผิดชอบ ({draft.selected.length})</label>
            <AvatarStack members={draft.selected} size={32} max={8} />
          </div>
        </section>
      )}

      {/* multi */}
      {isMulti && (
        <section className={styles.section}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Deadline รวมของงาน (ใช้กับข้อที่ไม่ระบุเอง)</label>
            <input
              type="datetime-local"
              className={styles.input}
              value={draft.globalDeadline ?? ''}
              onChange={(e) => setDraft({ ...draft, globalDeadline: e.target.value || null })}
            />
          </div>
          <p className={styles.sectionLabel}>รายการงาน ({draft.items.length})</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {draft.items.map((item, i) => (
              <div key={i} className={styles.itemCard}>
                <span className={styles.numBadge}>{i + 1}</span>
                <div className={styles.itemBody}>
                  <p className={styles.itemTitle}>{item.title}</p>
                  <div className={styles.itemMeta}>
                    <AvatarStack members={item.assignees} size={24} max={4} />
                    <DeadlineChip iso={item.deadline ? localToIso(item.deadline) : null} />
                  </div>
                </div>
                <button
                  type="button"
                  className={styles.ghostBtn}
                  onClick={() => removeItem(i)}
                  aria-label={`ลบ ${item.title}`}
                >
                  ลบ
                </button>
              </div>
            ))}
            <button type="button" className={styles.addItemBtn} onClick={openSheet}>
              + เพิ่มรายการ
            </button>
          </div>
        </section>
      )}

      {/* recurring */}
      {isRecurring && (
        <section className={styles.section}>
          <div className={styles.card}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>เตือนซ้ำทุก</label>
              <select
                className={styles.select}
                value={draft.recurrence.freq}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    recurrence: { ...draft.recurrence, freq: e.target.value as 'daily' | 'weekly' | 'monthly' },
                  })
                }
              >
                <option value="daily">วัน</option>
                <option value="weekly">สัปดาห์</option>
                <option value="monthly">เดือน</option>
              </select>
            </div>
            <div className={styles.inlineFields}>
              {draft.recurrence.freq === 'monthly' && (
                <div className={styles.field} style={{ flex: '0 0 120px' }}>
                  <label className={styles.fieldLabel}>ทุกวันที่</label>
                  <select
                    className={styles.select}
                    value={draft.recurrence.day}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        recurrence: { ...draft.recurrence, day: Number(e.target.value) },
                      })
                    }
                  >
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {draft.recurrence.freq === 'weekly' && (
                <div className={styles.field} style={{ flex: '0 0 120px' }}>
                  <label className={styles.fieldLabel}>ทุกวัน</label>
                  <select
                    className={styles.select}
                    value={draft.recurrence.weekday}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        recurrence: { ...draft.recurrence, weekday: Number(e.target.value) },
                      })
                    }
                  >
                    {WEEKDAYS.map((name, i) => (
                      <option key={i} value={i}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className={styles.field} style={{ flex: 1, maxWidth: 160 }}>
                <label className={styles.fieldLabel}>เวลา</label>
                <input
                  type="time"
                  className={styles.input}
                  value={draft.recurrence.time}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      recurrence: { ...draft.recurrence, time: e.target.value || '09:00' },
                    })
                  }
                />
              </div>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>รายละเอียด (ไม่บังคับ)</label>
              <textarea
                className={styles.textarea}
                value={draft.description}
                maxLength={1000}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </div>
            <label className={styles.fieldLabel}>คนรับผิดชอบ ({draft.selected.length})</label>
            <AvatarStack members={draft.selected} size={32} max={8} />
          </div>
        </section>
      )}

      {error && <div className={styles.errorBox}>{error}</div>}

      <div className={styles.stickyFooter}>
        <div className={styles.footerRow}>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={() => router.push(`/liff/tasks/create/${params.type}/members`)}
          >
            ← กลับ
          </button>
          <button type="button" className={styles.primaryBtn} disabled={submitting} onClick={submit}>
            {submitting ? 'กำลังส่ง...' : 'ส่งงานเข้ากลุ่ม →'}
          </button>
        </div>
      </div>

      {/* multi: add-item bottom sheet */}
      {sheetOpen && (
        <div className={styles.sheetOverlay} onClick={() => setSheetOpen(false)}>
          <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
            <div className={styles.sheetHandle} />
            <div className={styles.field}>
              <label className={styles.fieldLabel}>ชื่อรายการ</label>
              <input
                className={styles.input}
                placeholder="เช่น เตรียมสไลด์นำเสนอ"
                value={sheetTitle}
                maxLength={200}
                onChange={(e) => setSheetTitle(e.target.value)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Deadline ของข้อนี้ (เว้นว่าง = ใช้ของงาน)</label>
              <input
                type="datetime-local"
                className={styles.input}
                value={sheetDeadline}
                onChange={(e) => setSheetDeadline(e.target.value)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>คนรับผิดชอบ ({draft.selected.length})</label>
              <div className={styles.footerRow}>
                <AvatarStack members={draft.selected} size={30} max={6} />
                <button type="button" className={styles.ghostBtn} onClick={goPickMembers}>
                  เลือกคน →
                </button>
              </div>
            </div>
            <button type="button" className={styles.primaryBtn} onClick={addItem}>
              เพิ่มรายการนี้
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
