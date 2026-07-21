'use client';

import { useState } from 'react';
import { ApiError, createPersonalTask } from '@/lib/api';
import styles from './tasks.module.css';

/** Modal form for creating a งานส่วนตัว directly from the dashboard.
 * Mirrors the LIFF single-task rules: title + future deadline required. */
export default function CreatePersonalTaskModal({
  onClose,
  onCreated,
  onUnauthorized,
}: {
  onClose: () => void;
  onCreated: () => void;
  onUnauthorized: () => void;
}) {
  const [title, setTitle] = useState('');
  const [deadline, setDeadline] = useState('');
  const [description, setDescription] = useState('');
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
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      onCreated();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onUnauthorized();
      else setError('สร้างงานไม่สำเร็จ ลองใหม่อีกทีน้า');
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
