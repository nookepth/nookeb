'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import type { LegacyBoxDto } from '@nookeb/shared';
import { THEMES } from '@nookeb/shared';
import { deleteLegacyBox, hasSession, listLegacyBoxes } from '@/lib/api';
import { startLineLogin } from '@/lib/auth';
import styles from './page.module.css';

/** "3 วันที่แล้ว"-style relative Thai date for the box card. */
function thaiAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'วันนี้';
  if (days === 1) return 'เมื่อวาน';
  if (days < 30) return `${days} วันที่แล้ว`;
  return new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function LegacyBoxListPage() {
  const [needsLogin, setNeedsLogin] = useState(false);
  const [boxes, setBoxes] = useState<LegacyBoxDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LegacyBoxDto | null>(null);
  const [deleting, setDeleting] = useState(false);
  const toastTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!hasSession()) {
      setNeedsLogin(true);
      return;
    }
    try {
      const res = await listLegacyBoxes();
      setBoxes(res.boxes);
      setError(null);
    } catch {
      setError('โหลดกล่องของขวัญไม่สำเร็จ ลองรีเฟรชอีกครั้งน้า');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  async function copyLink(box: LegacyBoxDto): Promise<void> {
    try {
      await navigator.clipboard.writeText(box.shareUrl);
      showToast('คัดลอกลิงก์แล้ว 🎁');
    } catch {
      showToast('คัดลอกไม่สำเร็จ ลองใหม่อีกทีน้า');
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteLegacyBox(pendingDelete.id);
      setBoxes((prev) => (prev ?? []).filter((b) => b.id !== pendingDelete.id));
      showToast('ลบกล่องแล้ว');
      setPendingDelete(null);
    } catch {
      showToast('ลบไม่สำเร็จ ลองใหม่อีกทีน้า');
    } finally {
      setDeleting(false);
    }
  }

  // Page background follows the most recent box's theme; rose otherwise.
  const lastTheme = THEMES[boxes?.[0]?.theme ?? 'rose'];

  const totalViews = useMemo(
    () => (boxes ?? []).reduce((sum, b) => sum + b.viewCount, 0),
    [boxes],
  );

  if (needsLogin) {
    return (
      <div className="center-page">
        <Image src="/logo.png" alt="หนูเก็บ" width={120} height={120} className="login-logo" priority />
        <h1>หนูเก็บ</h1>
        <p>เข้าสู่ระบบด้วย LINE เพื่อเปิดกล่องของขวัญของคุณ</p>
        <button className="btn" onClick={startLineLogin}>
          เข้าสู่ระบบด้วย LINE
        </button>
      </div>
    );
  }

  return (
    <main
      className={styles.page}
      style={
        {
          '--bx-page-bg': lastTheme.gradient,
          '--bx-accent': lastTheme.accent,
          '--bx-glow': lastTheme.glow,
          color: lastTheme.text,
        } as React.CSSProperties
      }
    >
      <div className={styles.container}>
        <header className={styles.header}>
          <a className={styles.back} href="/dashboard">
            ← กลับคลัง
          </a>
          <h1 className={styles.title}>
            <span aria-hidden>🎁</span> กล่องของขวัญ
          </h1>
          <p className={styles.subtitle}>สร้างของขวัญดิจิทัลให้คนที่คุณรัก</p>
        </header>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.topRow}>
          <span className={styles.stats}>
            {boxes ? `${boxes.length}/10 กล่อง · เปิดแล้ว ${totalViews} ครั้ง` : ' '}
          </span>
          <a className={styles.createBtn} href="/dashboard/legacy-box/new">
            <span aria-hidden>+</span> สร้างกล่องใหม่
          </a>
        </div>

        {boxes !== null && boxes.length === 0 && (
          <div className={styles.empty}>
            <span className={styles.emptyEmoji} aria-hidden>
              🎁
            </span>
            <p className={styles.emptyText}>
              ยังไม่มีกล่องของขวัญ ✨ สร้างกล่องแรกให้คนที่คุณรัก
            </p>
          </div>
        )}

        {boxes !== null && boxes.length > 0 && (
          <div className={styles.grid}>
            {boxes.map((box) => {
              const theme = THEMES[box.theme];
              return (
                <article
                  key={box.id}
                  className={styles.card}
                  style={
                    {
                      '--card-bg': theme.card,
                      '--card-text': theme.text,
                      '--card-accent': theme.accent,
                    } as React.CSSProperties
                  }
                >
                  {box.coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- presigned R2 URL
                    <img className={styles.cardCover} src={box.coverUrl} alt="" loading="lazy" />
                  ) : (
                    <div className={styles.cardCoverEmpty} aria-hidden>
                      🎁
                    </div>
                  )}
                  <h2 className={styles.cardTitle}>
                    <span aria-hidden>✨</span> {box.title}
                  </h2>
                  <p className={styles.cardMeta}>
                    เปิดแล้ว {box.viewCount} ครั้ง · {box.photoCount} รูป
                    <br />
                    สร้างเมื่อ {thaiAgo(box.createdAt)}
                  </p>
                  <div className={styles.cardActions}>
                    <button
                      type="button"
                      className={`${styles.cardBtn} ${styles.copyBtn}`}
                      onClick={() => void copyLink(box)}
                    >
                      คัดลอกลิงก์
                    </button>
                    <button
                      type="button"
                      className={`${styles.cardBtn} ${styles.deleteBtn}`}
                      onClick={() => setPendingDelete(box)}
                    >
                      ลบ
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {pendingDelete && (
        <div
          className={styles.modalBackdrop}
          onClick={() => !deleting && setPendingDelete(null)}
          role="presentation"
        >
          <div
            className={styles.modal}
            style={{ '--modal-accent': THEMES[pendingDelete.theme].accent } as React.CSSProperties}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-box-title"
          >
            <h2 id="delete-box-title" className={styles.modalTitle}>
              ลบ “{pendingDelete.title}” ?
            </h2>
            <p className={styles.modalText}>
              ลิงก์ที่แชร์ไปจะเปิดไม่ได้อีก และรูปในกล่องจะถูกลบถาวรใน 7 วัน
            </p>
            <div className={styles.modalActions}>
              <button
                type="button"
                className={`${styles.modalBtn} ${styles.modalCancel}`}
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
              >
                เก็บไว้ก่อน
              </button>
              <button
                type="button"
                className={`${styles.modalBtn} ${styles.modalConfirm}`}
                onClick={() => void confirmDelete()}
                disabled={deleting}
              >
                {deleting ? 'กำลังลบ…' : 'ลบกล่อง'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={styles.toast}>{toast}</div>}
    </main>
  );
}
