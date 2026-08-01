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
import styles from './page.module.css';

/**
 * หนูเก็บความทรงจำ — the standalone diary-reminder ADD-ON (migration 052).
 *
 * Deliberately its own section BELOW the three plan cards, and laid out
 * HORIZONTALLY at full width rather than as a fourth column: it is not a tier.
 * Any plan can hold it, and holding it changes nothing about the user's plan.
 *
 * EVERY PRICE COMES FROM THE API (GET /diary-addon/status → config/plans.ts
 * DIARY_ADDON_PRICE). Nothing here writes 49 or 365 — the "ตกวันละ N บาท" line
 * divides the served yearly price, so a price change carries into the copy.
 *
 * NO PAYMENT PROVIDER EXISTS. The subscribe CTA is DISABLED ("อัปเดตเร็วๆ นี้น้า",
 * same as the three tier buttons) and must never call POST
 * /diary-addon/subscribe — that endpoint grants paid access for free, so a live
 * button on it would give the add-on away. The settings panel below (notify time
 * / cancel) IS live, because it only ever affects a subscription that already
 * exists.
 */

/** The billing cycle toggle lives on the page; this section follows it. */
export default function DiaryAddonSection({ cycle }: { cycle: BillingCycle }) {
  const [status, setStatus] = useState<DiaryAddonStatusResponse | null>(null);

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

      {/* Horizontal band: identity + price on the left, what you get and the
          CTA on the right. See .addonCard in the module CSS for the tracks. */}
      <article className={`${styles.card} ${styles.addonCard}`}>
        {active && <span className={styles.badgeCurrent}>ใช้งานอยู่</span>}

        <div className={styles.addonIdentity}>
          <span className={styles.addonBadge}>เสริมพลังพิเศษ</span>

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
            // DERIVED from the API price, never written as a literal (file
            // header rule): yearly ÷ 365 is exactly 1 ฿ at today's price.
            <div className={styles.priceNote}>
              ตกวันละ {Math.round(status.pricing.yearly / 365).toLocaleString('th-TH')} บาทเท่านั้น
            </div>
          )}
        </div>

        <div className={styles.addonOffer}>
          <ul className={styles.addonFeatures}>
            <li>เตือนเขียนไดอารี่ทุกวัน ตามเวลาที่คุณเลือก</li>
            <li>หนูเก็บจะทักมาเตือนผ่าน LINE ทุกวัน</li>
            <li>ข้ามวันถ้าเขียนไปแล้ว ไม่รบกวน</li>
            <li>ใช้ได้ทุกแพลน ไม่ต้องอัปเกรด</li>
            {/* Number from the API (DIARY_ADDON_GIFT_BOX_QUOTA), like the
                prices. Enforced server-side as a FLOOR — a premium holder keeps
                their higher plan quota. Hidden rather than guessed if the
                status call failed. */}
            {status && <li>สร้างกล่องของขวัญได้ {status.giftBoxQuota} กล่อง/เดือน</li>}
          </ul>

          {active ? (
            <a className={`btn secondary ${styles.cta} ${styles.addonCta}`} href="#diary-addon-settings">
              ตั้งค่าเวลาเตือน
            </a>
          ) : (
            // TODO: enable when payment is live.
            // Disabled, exactly like the three tier CTAs above it. It must NOT
            // call subscribeDiaryAddon() — that endpoint grants the paid add-on
            // for free (see the file header).
            <button
              className={`btn ${styles.cta} ${styles.addonCta}`}
              disabled
              title="ยังเปิดให้ชำระเงินไม่ได้น้า"
            >
              อัปเดตเร็วๆ นี้น้า
            </button>
          )}
        </div>
      </article>

      {active && status?.subscription && (
        <DiaryAddonSettings status={status} onChanged={load} />
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
