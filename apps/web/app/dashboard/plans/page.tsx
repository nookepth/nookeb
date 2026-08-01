'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import {
  ApiError,
  getMyPlan,
  getMyQuotas,
  getPlans,
  hasSession,
  type BillingCycle,
  type MyPlanResponse,
  type MyQuotasResponse,
  type PlanSummaryDto,
} from '@/lib/api';
import { startLineLogin } from '@/lib/auth';
import { formatBytes } from '@/lib/format';
import { planDisplayName } from '@/lib/quota-errors';
import { quotaLevel } from '@/components/QuotaBanner';
import DiaryAddonSection from './DiaryAddonSection';
import styles from './page.module.css';

/**
 * แพลนของฉัน — the pricing table plus the caller's own usage.
 *
 * EVERY NUMBER ON THIS PAGE COMES FROM THE API. Prices, storage sizes and quota
 * limits are all read from GET /plans and GET /plans/me/quotas, which serve
 * apps/api/src/config/plans.ts — the single source of truth. Nothing here is
 * hard-coded, so a price change is a one-line edit in that config and this page
 * follows automatically.
 *
 * NO PAYMENT PROVIDER EXISTS YET. POST /plans/change records a plan change but
 * takes no money, so the upgrade CTAs are deliberately DISABLED rather than
 * wired up — shipping a working self-service "upgrade" button that charges
 * nothing would hand out paid tiers for free.
 */

/** The rows of the comparison table, in display order. */
const MONTHLY_ROWS: { feature: string; label: string; unit: string }[] = [
  { feature: 'tasks', label: 'สร้างงาน', unit: 'งาน/เดือน' },
  { feature: 'group_files', label: 'เก็บไฟล์ในกลุ่ม', unit: 'ไฟล์/เดือน' },
  { feature: 'scans', label: 'สแกนเอกสาร', unit: 'ครั้ง/เดือน' },
  { feature: 'pdf_merges', label: 'รวมไฟล์', unit: 'ครั้ง/เดือน' },
  { feature: 'word_conversion_pages', label: 'แปลงไฟล์เป็น Word', unit: 'หน้า/เดือน' },
  { feature: 'gift_boxes', label: 'กล่องของขวัญ', unit: 'กล่อง/เดือน' },
];

const CAPACITY_ROWS: { feature: string; label: string; unit: string }[] = [
  { feature: 'vault_files', label: 'ห้องนิรภัย', unit: 'ไฟล์' },
  { feature: 'group_boosts', label: 'บูธกลุ่ม', unit: 'กลุ่ม' },
];

const FEATURE_ROWS: { feature: string; label: string }[] = [
  { feature: 'export_task_summary', label: 'ดาวน์โหลดสรุปงาน (Excel)' },
  { feature: 'notify_only_pending', label: 'เตือนเฉพาะคนที่ยังไม่ส่งงาน' },
  { feature: 'google_sheets', label: 'เชื่อม Google Sheets' },
  { feature: 'performance_report', label: 'รายงานผลการทำงานรายบุคคล' },
  { feature: 'onboarding_call', label: 'นัดตั้งค่าเริ่มต้นตัวต่อตัว' },
];

/** -1 is the UNLIMITED sentinel from config/plans.ts. */
function limitText(n: number | undefined, unit: string): string {
  if (n === undefined) return '—';
  if (n < 0) return 'ไม่จำกัด';
  return `${n.toLocaleString('th-TH')} ${unit}`;
}

/**
 * ราคาก่อนลด (compare-at) — the ONLY numbers on this page that do not come from
 * the API. They are a marketing anchor, not a price the system ever charged, so
 * config/plans.ts has no field for them; adding one would imply the billing code
 * could bill it. Keyed by plan, monthly figure only — the yearly anchor is 10×,
 * the same "two months free" shape as the real yearly price.
 */
const COMPARE_AT_MONTHLY: Record<string, number> = {
  pro: 109,
  premium: 259,
};

function baht(amount: number): string {
  return `${amount.toLocaleString('th-TH')} บาท`;
}

/** The struck-through anchor above the price, or null when there isn't one. */
function compareAtText(plan: PlanSummaryDto, cycle: BillingCycle): string | null {
  const monthly = COMPARE_AT_MONTHLY[plan.plan];
  if (!monthly || plan.pricing.monthly <= 0) return null;
  return baht(cycle === 'monthly' ? monthly : monthly * 10);
}

function priceText(plan: PlanSummaryDto, cycle: BillingCycle): string {
  // The free plan has no yearly price (null) — it still reads "ฟรี" on both
  // tabs rather than falling through to the "not sold" dash.
  if (plan.pricing.monthly === 0) return 'ฟรี';
  const amount = cycle === 'monthly' ? plan.pricing.monthly : plan.pricing.yearly;
  if (amount === null) return '—';
  return `${baht(amount)}/${cycle === 'monthly' ? 'เดือน' : 'ปี'}`;
}

/**
 * The line under the price: the OTHER cycle's figure, so whichever tab you are
 * on you can see what the alternative costs without switching.
 */
function priceSubLabel(plan: PlanSummaryDto, cycle: BillingCycle): string | null {
  if (plan.pricing.monthly <= 0 || plan.pricing.yearly === null) return null;
  if (cycle === 'monthly') return `${baht(plan.pricing.yearly)}/ปี`;
  return `เฉลี่ย ${baht(Math.round(plan.pricing.yearly / 12))}/เดือน`;
}

export default function PlansPage() {
  const [needsLogin, setNeedsLogin] = useState(false);
  const [plans, setPlans] = useState<PlanSummaryDto[] | null>(null);
  const [me, setMe] = useState<MyPlanResponse | null>(null);
  const [quotas, setQuotas] = useState<MyQuotasResponse | null>(null);
  // รายปี is the default tab — it is the better deal and the one we lead with.
  const [cycle, setCycle] = useState<BillingCycle>('yearly');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // The price list is public, so it loads even without a session — a logged
    // out visitor still gets the table, just without their own usage on it.
    try {
      setPlans((await getPlans()).plans);
      setError(null);
    } catch {
      setError('โหลดข้อมูลแพลนไม่สำเร็จ ลองรีเฟรชอีกครั้งน้า');
      return;
    }
    if (!hasSession()) {
      setNeedsLogin(true);
      return;
    }
    try {
      const [mine, q] = await Promise.all([getMyPlan(), getMyQuotas()]);
      setMe(mine);
      setQuotas(q);
      setNeedsLogin(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedsLogin(true);
      // Any other failure leaves the table rendered without personal usage,
      // which is still a useful page.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const currentPlan = me?.plan ?? null;

  /** "เริ่มนับใหม่ 1 ก.ย." — when the monthly counters roll over. */
  const resetLabel = useMemo(() => {
    if (!quotas?.resetAt) return null;
    return new Date(quotas.resetAt).toLocaleDateString('th-TH', {
      day: 'numeric',
      month: 'short',
    });
  }, [quotas]);

  if (needsLogin && !plans) {
    return (
      <div className="center-page">
        <Image src="/logo.png" alt="หนูเก็บ" width={120} height={120} className="login-logo" priority />
        <h1>หนูเก็บ</h1>
        <p>เข้าสู่ระบบด้วย LINE เพื่อดูแพลนของคุณ</p>
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
        <h1 className={styles.title}>แพลนของฉัน</h1>
        <p className={styles.subtitle}>
          เลือกแพลนที่พอดีกับการใช้งาน — โควต้ารายเดือนรีเซตใหม่ทุกวันที่ 1
        </p>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      {/* ---- current plan + live usage ---- */}
      {me && (
        <section className={styles.current}>
          <div className={styles.currentTop}>
            <span className={styles.currentLabel}>แพลนปัจจุบัน</span>
            <span className={styles.currentPlan}>{planDisplayName(me.plan)}</span>
          </div>
          <div className={styles.currentStorage}>
            พื้นที่เก็บไฟล์ {formatBytes(me.locker.usedBytes)} จาก{' '}
            {formatBytes(me.locker.limitBytes)}
            {me.referralCount > 0 && ` (รวมโบนัสจากการชวนเพื่อน ${me.referralCount} คน)`}
          </div>

          {quotas && quotas.quotas.length > 0 && (
            <>
              <div className={styles.usageHead}>
                การใช้งานเดือนนี้{resetLabel ? ` · เริ่มนับใหม่ ${resetLabel}` : ''}
              </div>
              <ul className={styles.usageList}>
                {MONTHLY_ROWS.map((row) => {
                  const q = quotas.quotas.find((x) => x.feature === row.feature);
                  if (!q) return null;
                  const pct = q.unlimited
                    ? 0
                    : Math.min(100, q.limit > 0 ? Math.round((q.used / q.limit) * 100) : 100);
                  // Same thresholds as the inline banner, so a counter here and
                  // a counter on a feature page never disagree about "full".
                  const level = quotaLevel(q);
                  return (
                    <li key={row.feature} className={styles.usageItem}>
                      <span className={styles.usageName}>{row.label}</span>
                      <span
                        className={`${styles.usageNum} ${
                          level === 'full'
                            ? styles.usageNumFull
                            : level === 'near'
                              ? styles.usageNear
                              : ''
                        }`}
                      >
                        {q.unlimited ? `${q.used} (ไม่จำกัด)` : `${q.used}/${q.limit}`}
                      </span>
                      {!q.unlimited && (
                        <span className={styles.usageTrack} aria-hidden>
                          <span
                            className={`${styles.usageFill} ${pct >= 100 ? styles.usageFull : ''}`}
                            style={{ width: `${pct}%` }}
                          />
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      )}

      {/* ---- billing cycle toggle ---- */}
      <div className={styles.cycleToggle} role="group" aria-label="รอบการชำระเงิน">
        <button
          className={cycle === 'yearly' ? styles.cycleActive : styles.cycleBtn}
          onClick={() => setCycle('yearly')}
          aria-pressed={cycle === 'yearly'}
        >
          รายปี
          <span className={styles.cycleSave}>ประหยัด 2 เดือน</span>
        </button>
        <button
          className={cycle === 'monthly' ? styles.cycleActive : styles.cycleBtn}
          onClick={() => setCycle('monthly')}
          aria-pressed={cycle === 'monthly'}
        >
          รายเดือน
        </button>
      </div>

      {/* ---- the three plan cards ---- */}
      <div className={styles.cards}>
        {(plans ?? []).map((plan) => {
          const isCurrent = plan.plan === currentPlan;
          // Pro is the recommended tier — it is the first paid step and covers
          // the limits most groups actually hit.
          const recommended = plan.plan === 'pro';
          // The free tier has no compare-at anchor and no "other cycle" line,
          // so its price block would be one line tall against the paid cards'
          // three. Render the same two tags anyway with placeholder text and
          // visibility:hidden — they hold the height without being seen or read.
          const compareAt = compareAtText(plan, cycle);
          const subLabel = priceSubLabel(plan, cycle);
          return (
            <section
              key={plan.plan}
              className={`${styles.card} ${recommended ? styles.cardRecommended : ''} ${
                isCurrent ? styles.cardCurrent : ''
              }`}
            >
              {recommended && <span className={styles.badgeRecommended}>แนะนำ</span>}
              {isCurrent && <span className={styles.badgeCurrent}>แพลนปัจจุบัน</span>}

              {/* No emoji on tier names — brand rule. Name comes from the API. */}
              <h2 className={styles.cardName}>{plan.displayName}</h2>

              <div
                className={styles.priceCompare}
                style={compareAt ? undefined : { visibility: 'hidden' }}
                aria-hidden={compareAt ? undefined : true}
              >
                {compareAt ?? '— บาท'}
              </div>
              <div className={styles.priceRow}>
                <span className={styles.price}>{priceText(plan, cycle)}</span>
              </div>
              <div
                className={styles.priceNote}
                style={subLabel ? undefined : { visibility: 'hidden' }}
                aria-hidden={subLabel ? undefined : true}
              >
                {subLabel ?? '— บาท/ปี'}
              </div>

              <div className={styles.storage}>
                พื้นที่ {formatBytes(plan.lockerBytes)}
                {plan.features.referral_storage_bonus &&
                  plan.lockerMaxBytesWithReferrals > plan.lockerBytes &&
                  ` (ชวนเพื่อนเพิ่มได้ถึง ${formatBytes(plan.lockerMaxBytesWithReferrals)})`}
              </div>

              <ul className={styles.featureList}>
                {MONTHLY_ROWS.map((row) => (
                  <li key={row.feature}>
                    <span>{row.label}</span>
                    <b>{limitText(plan.monthly[row.feature], row.unit)}</b>
                  </li>
                ))}
                {CAPACITY_ROWS.map((row) => (
                  <li key={row.feature}>
                    <span>{row.label}</span>
                    <b>{limitText(plan.capacity[row.feature], row.unit)}</b>
                  </li>
                ))}
                <li>
                  <span>เตือนงานล่วงหน้า</span>
                  <b>เลือกได้ {plan.reminder.maxSelectable} ช่วง</b>
                </li>
                <li>
                  <span>เก็บไฟล์ในถังขยะ</span>
                  <b>{plan.trashRetentionDays} วัน</b>
                </li>
                <li>
                  <span>ตอบกลับซัพพอร์ตภายใน</span>
                  <b>{plan.slaHours} ชม.</b>
                </li>
                {FEATURE_ROWS.map((row) => (
                  <li key={row.feature} className={plan.features[row.feature] ? '' : styles.featureOff}>
                    <span>{row.label}</span>
                    <b>{plan.features[row.feature] ? 'ใช้ได้' : '—'}</b>
                  </li>
                ))}
              </ul>

              {/* Payment is not live. The button stays (so the layout and the
                  intent are real) but is disabled — see the file header. */}
              {isCurrent ? (
                <button className={`btn secondary ${styles.cta}`} disabled>
                  กำลังใช้อยู่
                </button>
              ) : plan.plan === 'free' ? (
                <button className={`btn secondary ${styles.cta}`} disabled>
                  แพลนเริ่มต้น
                </button>
              ) : (
                <button className={`btn ${styles.cta}`} disabled title="ยังเปิดให้ชำระเงินไม่ได้น้า">
                  อัปเดตเร็วๆ นี้น้า
                </button>
              )}
            </section>
          );
        })}
      </div>

      {/* ---- add-ons ----
          Below the tiers and visually separated, because หนูเก็บความทรงจำ is
          NOT a fourth plan: any tier can hold it and buying it does not change
          the user's plan. It follows the billing-cycle toggle above. */}
      <DiaryAddonSection cycle={cycle} />

      <p className={styles.footnote}>
        โควต้ารายเดือนรีเซตทุกวันที่ 1 เวลา 00:00 น. (เวลาไทย) — อัปเกรดกลางเดือนได้เลย
        โควต้าที่ใช้ไปแล้วจะไม่ถูกล้าง แต่เพดานจะขยับขึ้นทันทีน้า
        {' · '}
        <a href="/dashboard/boosts">จัดการบูธกลุ่ม</a>
      </p>
    </main>
  );
}
