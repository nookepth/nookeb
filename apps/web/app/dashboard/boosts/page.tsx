'use client';

import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import { ApiError, getBoosts, hasSession, type BoostStatusResponse } from '@/lib/api';
import { startLineLogin } from '@/lib/auth';
import { planDisplayName } from '@/lib/quota-errors';
import styles from './page.module.css';

/**
 * บูธกลุ่ม — slots, what is currently boosted, and how to boost.
 *
 * WHY THIS PAGE IS READ-ONLY. Activating a boost needs the user to pick a LINE
 * GROUP, and this codebase has no groups table: the LINE group id IS the tenant
 * key (CLAUDE.md §8), and nothing stores group names. A web picker could
 * therefore only offer "กลุ่ม …a1b2c3" — six characters of an opaque id — which
 * is not a choice anyone can make correctly.
 *
 * The in-chat `บูธ` command has the context the web lacks: it runs INSIDE the
 * group being boosted, so the user never has to identify it. That command is
 * fully implemented (routes/webhook/boost-handlers.ts), so this page states the
 * real state and points at the path that works, rather than pretending a web
 * picker is one release away.
 */
export default function BoostsPage() {
  const [needsLogin, setNeedsLogin] = useState(false);
  const [status, setStatus] = useState<BoostStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!hasSession()) {
      setNeedsLogin(true);
      return;
    }
    try {
      setStatus(await getBoosts());
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedsLogin(true);
      else setError('โหลดข้อมูลบูธไม่สำเร็จ ลองรีเฟรชอีกครั้งน้า');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (needsLogin) {
    return (
      <div className="center-page">
        <Image src="/logo.png" alt="หนูเก็บ" width={120} height={120} className="login-logo" priority />
        <h1>หนูเก็บ</h1>
        <p>เข้าสู่ระบบด้วย LINE เพื่อดูบูธกลุ่มของคุณ</p>
        <button className="btn" onClick={startLineLogin}>
          เข้าสู่ระบบด้วย LINE
        </button>
      </div>
    );
  }

  return (
    <main className={`container ${styles.container}`}>
      <header className={styles.header}>
        <a className={styles.back} href="/dashboard">
          ← กลับคลัง
        </a>
        <h1 className={styles.title}>บูธกลุ่ม</h1>
        <p className={styles.subtitle}>
          บูธกลุ่มไหน กลุ่มนั้นจะเก็บไฟล์ได้เยอะขึ้นตามแพลนของคุณน้า
        </p>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      {status && (
        <>
          <section className={styles.statusCard}>
            <div className={styles.slotRow}>
              <span className={styles.slotNum}>
                {status.used}/{status.limit}
              </span>
              <span className={styles.slotLabel}>
                กลุ่มที่บูธอยู่ · แพลน{planDisplayName(status.plan)}
              </span>
            </div>

            {status.limit === 0 ? (
              <p className={styles.upsell}>
                แพลนนี้ยังบูธกลุ่มไม่ได้น้า —{' '}
                <a href="/dashboard/plans">ดูแพลนที่บูธได้</a>
              </p>
            ) : (
              <p className={styles.slotHint}>
                บูธได้ครั้งละ {status.durationDays} วัน · เหลืออีก {status.available} สิทธิ์
              </p>
            )}
          </section>

          {status.boosts.length > 0 && (
            <section className={styles.listCard}>
              <h2 className={styles.listTitle}>กลุ่มที่บูธอยู่</h2>
              <ul className={styles.list}>
                {status.boosts.map((b) => (
                  <li key={b.groupId} className={styles.listItem}>
                    {/* Only the id tail is available — see the file header. */}
                    <span className={styles.groupId}>กลุ่ม …{b.groupId.slice(-6)}</span>
                    <span className={styles.expiry}>
                      ถึง{' '}
                      {new Date(b.expiresAt).toLocaleDateString('th-TH', {
                        day: 'numeric',
                        month: 'short',
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <section className={styles.howto}>
        <h2 className={styles.listTitle}>วิธีบูธกลุ่ม</h2>
        <p className={styles.howtoText}>
          การเลือกกลุ่มบนเว็บกำลังมาเร็วๆ นี้น้า — ตอนนี้บูธผ่านแชทได้เลย
        </p>
        <ol className={styles.steps}>
          <li>เปิดแชทกลุ่มที่อยากบูธ (ต้องมีหนูเก็บอยู่ในกลุ่มน้า)</li>
          <li>
            พิมพ์ว่า <code className={styles.cmd}>บูธ</code>
          </li>
          <li>หนูจะยืนยันให้ในแชทเลยน้า</li>
        </ol>
        <p className={styles.howtoNote}>
          พิมพ์ <code className={styles.cmd}>บูธ</code> ในแชทส่วนตัวกับหนู
          เพื่อดูหรือปลดบูธที่ใช้อยู่ได้น้า
        </p>
      </section>
    </main>
  );
}
