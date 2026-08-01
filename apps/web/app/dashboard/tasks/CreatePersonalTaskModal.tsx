'use client';

import { useState } from 'react';
import { ApiError, createPersonalTask } from '@/lib/api';
import {
  MAX_REMINDER_COUNT,
  REMINDER_COUNT_HINT,
  URGENCY_OPTIONS,
  type TaskUrgency,
} from '@/lib/taskDraft';
import styles from './tasks.module.css';

/** Modal form for creating a งานส่วนตัว directly from the dashboard.
 * Mirrors the LIFF single-task rules: title + future deadline required. */
export default function CreatePersonalTaskModal({
  onClose,
  onCreated,
  onUnauthorized,
  onQuotaExceeded,
  onPlanGate,
}: {
  onClose: () => void;
  onCreated: () => void;
  onUnauthorized: () => void;
  /**
   * §5 — the monthly task quota (7/25/100) rejected the create. Handed UP
   * rather than shown here: an inline red line under a form invites the user to
   * fix their input and press again, and no input can make this succeed until
   * the 1st. The parent closes this form and shows the quota card instead.
   */
  onQuotaExceeded: (feature: string, resetAt?: string) => void;
  /** 403 PLAN_UPGRADE_REQUIRED — same reasoning, different card. */
  onPlanGate: (requiredPlan?: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [deadline, setDeadline] = useState('');
  const [description, setDescription] = useState('');
  const [urgency, setUrgency] = useState<TaskUrgency>('normal');
  // จำนวนการแจ้งเตือน — 0 by default; a reminder is a LINE push, so it is opted
  // into, not defaulted into. The plan ceiling is the API's to enforce.
  const [reminderCount, setReminderCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (submitting) return;
    if (!title.trim()) {
      setError('ตั้งชื่องานก่อนน้า');
      return;
    }
    if (!deadline) {
      setError('เลือกกำหนดส่งก่อนน้า');
      return;
    }
    const deadlineMs = new Date(deadline).getTime();
    if (Number.isNaN(deadlineMs) || deadlineMs <= Date.now()) {
      setError('กำหนดส่งต้องอยู่ในอนาคตน้า');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await createPersonalTask({
        title: title.trim(),
        globalDeadline: new Date(deadline).toISOString(),
        urgency,
        ...(reminderCount > 0 ? { reminderCount } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      onCreated();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onUnauthorized();
      else if (err instanceof ApiError && err.code === 'QUOTA_EXCEEDED') {
        onQuotaExceeded(err.details?.feature ?? 'tasks', err.details?.resetAt);
      } else if (err instanceof ApiError && err.code === 'PLAN_UPGRADE_REQUIRED') {
        onPlanGate(err.details?.requiredPlan);
      } else if (err instanceof ApiError && err.code === 'REMINDER_INTERVAL_LIMIT') {
        // Shown INLINE, unlike the quota/plan cards above: this one the user can
        // fix right here by lowering the count, so closing the form would be
        // hostile. The API's message already names their limit.
        setError(err.message);
      } else setError('สร้างงานไม่สำเร็จ ลองใหม่อีกทีน้า');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.modalTitle}>สร้างงานส่วนตัว</h2>

        <label className={styles.fieldLabel}>ชื่องาน</label>
        <input
          className={styles.input}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="เช่น ส่งรายงานประจำเดือน"
          maxLength={200}
          autoFocus
        />

        <label className={styles.fieldLabel} style={{ marginTop: 12 }}>
          กำหนดส่ง
        </label>
        <div className={styles.tdDateInputWrap}>
          <input
            className={styles.input}
            type="datetime-local"
            style={{ border: 'none' }}
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
          />
        </div>

        <label className={styles.fieldLabel} style={{ marginTop: 12 }}>
          ความเร่งด่วน
        </label>
        <div role="radiogroup" aria-label="ความเร่งด่วน" style={{ display: 'flex', gap: 8 }}>
          {URGENCY_OPTIONS.map((opt) => {
            const active = urgency === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setUrgency(opt.value)}
                style={{
                  flex: '1 1 0',
                  minWidth: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '9px 4px',
                  borderRadius: 10,
                  cursor: 'pointer',
                  border: `1.5px solid ${active ? opt.color : '#E5E7EB'}`,
                  background: active ? `${opt.color}14` : '#fff',
                  color: active ? opt.color : '#6B7280',
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: active ? 700 : 500,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: opt.color,
                    flexShrink: 0,
                  }}
                />
                {opt.label}
              </button>
            );
          })}
        </div>

        <label className={styles.fieldLabel} style={{ marginTop: 12 }} htmlFor="reminderCount">
          จำนวนการแจ้งเตือน (ครั้ง)
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            id="reminderCount"
            className={styles.input}
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_REMINDER_COUNT}
            step={1}
            value={reminderCount}
            onChange={(e) => {
              const raw = Number.parseInt(e.target.value, 10);
              setReminderCount(
                Number.isFinite(raw) ? Math.min(MAX_REMINDER_COUNT, Math.max(0, raw)) : 0,
              );
            }}
            style={{ width: 96, textAlign: 'center' }}
          />
          <span style={{ fontSize: 13, color: '#6B7280' }}>
            {REMINDER_COUNT_HINT[reminderCount] ?? ''}
          </span>
        </div>
        <p style={{ margin: '6px 0 0', fontSize: 12, lineHeight: 1.5, color: '#6B7280' }}>
          0 = ไม่เตือน · สูงสุด {MAX_REMINDER_COUNT} ครั้ง — จำนวนที่ตั้งได้จริงขึ้นกับแพ็กเกจ (ฟรี 1 / Pro 2 /
          Premium 4)
        </p>

        <label className={styles.fieldLabel} style={{ marginTop: 12 }}>
          รายละเอียด (ไม่บังคับ)
        </label>
        <textarea
          className={styles.textarea}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="อธิบายงานเพิ่มเติม..."
          maxLength={1000}
        />

        {error && (
          <p className={styles.modalError} role="alert">
            {error}
          </p>
        )}

        <div className={styles.modalActions}>
          <button type="button" className={styles.ghostBtn} onClick={onClose} disabled={submitting}>
            ยกเลิก
          </button>
          <button type="button" className={styles.primaryBtn} onClick={() => void submit()} disabled={submitting}>
            {submitting ? 'กำลังสร้าง...' : 'สร้างงาน'}
          </button>
        </div>
      </div>
    </div>
  );
}
