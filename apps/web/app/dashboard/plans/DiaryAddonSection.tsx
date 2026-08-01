'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  cancelDiaryAddon,
  getDiaryAddonStatus,
  setDiaryAddonNotifyTime,
  type BillingCycle,
  type DiaryAddonStatusResponse,
} from '@/lib/api';
import { LINE_ADD_FRIEND_URL } from '@/lib/site';
import styles from './page.module.css';

/**
 * หนูเก็บความทรงจำ — the standalone diary-reminder ADD-ON (migration 052).
 *
 * Deliberately its own section BELOW the three plan cards, not a fourth card:
 * it is not a tier. Any plan can hold it, and holding it changes nothing about
 * the user's plan.
 *
 * EVERY PRICE COMES FROM THE API (GET /diary-addon/status → config/plans.ts
 * DIARY_ADDON_PRICE). Nothing here writes 49 or 365.
 *
 * NO PAYMENT PROVIDER EXISTS. The subscribe CTA opens a coming-soon modal and
 * never calls POST /diary-addon/subscribe — that endpoint grants paid access for
 * free, so a button on it would give the add-on away. The settings panel below
 * (notify time / cancel) IS live, because it only ever affects a subscription
 * that already exists.
 */

/** The billing cycle toggle lives on the page; this section follows it. */
export default function DiaryAddonSection({ cycle }: { cycle: BillingCycle }) {
  const [status, setStatus] = useState<DiaryAddonStatusResponse | null>(null);
  const [showComingSoon, setShowComingSoon] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await getDiaryAddonStatus());
    } catch {
      // A logged-out visitor (401) or a transient failure: the offer still
      // renders from the plan page's own copy, just without personal state.
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const price = status
    ? cycle === 'monthly'
      ? status.pricing.monthly
      : status.pricing.yearly
    : null;

  const active = status?.active ?? false;

  return (
    <section className={styles.addonSection}>
      <div className={styles.addonDivider}>
        <span>เสริมพลังพิเศษ</span>
      </div>

      <article className={`${styles.card} ${styles.addonCard}`}>
        {active && <span className={styles.badgeCurrent}>ใช้งานอยู่</span>}

        {/* No emoji on add-on names — same brand rule as the tier names. */}
        <h2 className={styles.cardName}>{status?.name ?? 'หนูเก็บความทรงจำ'}</h2>
        <p className={styles.addonTagline}>เตือนเขียนไดอารี่ทุกวัน ไม่มีวันลืม</p>

        <div className={styles.priceRow}>
          <span className={styles.price}>
            {price === null ? '—' : `${price.toLocaleString('th-TH')} ฿`}
          </span>
          <span className={styles.pricePer}>/{cycle === 'monthly' ? 'เดือน' : 'ปี'}</span>
        </div>
        {cycle === 'yearly' && status && (
          <div className={styles.priceNote}>
            เฉลี่ย {(status.pricing.yearly / 12).toFixed(1).replace('.0', '')} ฿/เดือน — ถูกกว่ารายเดือน
          </div>
        )}

        <ul className={styles.featureList}>
          <li>
            <span>เตือนเขียนไดอารี่ทุกวัน ตามเวลาที่คุณเลือก</span>
          </li>
          <li>
            <span>หนูเก็บจะทักมาเตือนผ่าน LINE ทุกวัน</span>
          </li>
          <li>
            <span>ข้ามวันถ้าเขียนไปแล้ว ไม่รบกวน</span>
          </li>
          <li>
            <span>ใช้ได้ทุกแพลน ไม่ต้องอัปเกรด</span>
          </li>
        </ul>

        {active ? (
          <a className={`btn secondary ${styles.cta}`} href="#diary-addon-settings">
            ตั้งค่าเวลาเตือน
          </a>
        ) : (
          // TODO(payment): replace with a real checkout flow. Until then this
          // must NOT call subscribeDiaryAddon() — see the file header.
          <button className={`btn ${styles.cta}`} onClick={() => setShowComingSoon(true)}>
            สมัครหนูเก็บความทรงจำ
          </button>
        )}
      </article>

      {active && status?.subscription && (
        <DiaryAddonSettings status={status} onChanged={load} />
      )}

      {showComingSoon && (
        <div
          className={styles.modalOverlay}
          role="dialog"
          aria-modal="true"
          aria-label="หนูเก็บความทรงจำ"
          onClick={() => setShowComingSoon(false)}
        >
          <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>กำลังเปิดตัวเร็วๆ นี้น้า</h3>
            <p className={styles.modalBody}>
              ลงทะเบียนความสนใจไว้ก่อนได้เลย ทักหาหนูเก็บใน LINE
              แล้วหนูจะบอกทันทีที่เปิดให้สมัครน้า
            </p>
            <div className={styles.modalActions}>
              <a
                className="btn"
                href={LINE_ADD_FRIEND_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                ทักหนูเก็บใน LINE
              </a>
              <button className="btn secondary" onClick={() => setShowComingSoon(false)}>
                ปิด
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Settings for an ACTIVE subscriber only. Both actions here are live against
 * the API: neither takes or refunds money, they only steer a subscription the
 * user already has.
 */
function DiaryAddonSettings({
  status,
  onChanged,
}: {
  status: DiaryAddonStatusResponse;
  onChanged: () => Promise<void>;
}) {
  const sub = status.subscription!;
  const [time, setTime] = useState(sub.notifyTime);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  // A reload after save/cancel replaces the row; follow it so the input never
  // shows a value the server disagrees with.
  useEffect(() => {
    setTime(sub.notifyTime);
  }, [sub.notifyTime]);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await setDiaryAddonNotifyTime(time);
      setMessage(`บันทึกแล้วน้า หนูจะทักตอน ${res.notifyTime} ทุกวัน`);
      await onChanged();
    } catch (err) {
      setError(
        err instanceof ApiError && err.message
          ? err.message
          : 'บันทึกเวลาไม่สำเร็จ ลองใหม่อีกครั้งน้า',
      );
    } finally {
      setSaving(false);
    }
  };

  const cancel = async () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await cancelDiaryAddon();
      setConfirmCancel(false);
      setMessage(
        `ยกเลิกแล้วน้า ยังใช้ได้ถึง ${new Date(res.expiresAt).toLocaleDateString('th-TH', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })}`,
      );
      await onChanged();
    } catch (err) {
      setError(
        err instanceof ApiError && err.message ? err.message : 'ยกเลิกไม่สำเร็จ ลองใหม่อีกครั้งน้า',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className={styles.addonSettings} id="diary-addon-settings">
      <h3 className={styles.addonSettingsTitle}>ตั้งค่าหนูเก็บความทรงจำ</h3>

      <div className={styles.addonMeta}>
        รอบ{sub.billingCycle === 'monthly' ? 'รายเดือน' : 'รายปี'} · ใช้ได้อีก {sub.daysLeft} วัน
        {sub.status === 'cancelled' && ' · ยกเลิกแล้ว จะไม่ต่ออายุอัตโนมัติ'}
      </div>

      <label className={styles.addonField}>
        <span>เวลาที่อยากให้หนูทักเตือน (เวลาไทย)</span>
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          className={styles.addonTimeInput}
        />
      </label>

      <div className={styles.addonActions}>
        <button className="btn" onClick={save} disabled={saving || time === sub.notifyTime}>
          บันทึกเวลา
        </button>
        {sub.status === 'active' && (
          <button
            className={styles.addonCancelLink}
            onClick={() => setConfirmCancel(true)}
            disabled={saving}
          >
            ยกเลิกหนูเก็บความทรงจำ
          </button>
        )}
      </div>

      {message && <p className={styles.addonOk}>{message}</p>}
      {error && <p className={styles.error}>{error}</p>}

      {confirmCancel && (
        <div
          className={styles.modalOverlay}
          role="dialog"
          aria-modal="true"
          aria-label="ยืนยันการยกเลิก"
          onClick={() => setConfirmCancel(false)}
        >
          <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>ยกเลิกหนูเก็บความทรงจำ?</h3>
            <p className={styles.modalBody}>
              หนูจะหยุดทักเตือนเมื่อครบรอบที่จ่ายไว้แล้วน้า ระหว่างนี้ยังใช้ได้ตามปกติ
              — กลับมาสมัครใหม่ได้ทุกเมื่อ
            </p>
            <div className={styles.modalActions}>
              <button className="btn" onClick={cancel} disabled={saving}>
                ยืนยันยกเลิก
              </button>
              <button className="btn secondary" onClick={() => setConfirmCancel(false)}>
                ไม่ยกเลิก
              </button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
