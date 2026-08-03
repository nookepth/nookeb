'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { getPlans, type BillingCycle, type PlanSummaryDto } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { LINE_ADD_FRIEND_URL } from '@/lib/site';
// THE CARD DESIGN IS THE ACCOUNT PAGE'S, imported rather than reproduced. If
// /dashboard/plans restyles a tier card, this block restyles with it — two
// pricing tables that drift apart is the failure this import prevents.
import card from '@/app/dashboard/plans/page.module.css';
import s from './PlansSection.module.css';

/**
 * เลือกแพลนที่ใช่สำหรับคุณ — the pricing block on the public landing page.
 *
 * EVERY NUMBER COMES FROM THE API. `GET /plans` is unauthenticated precisely so
 * this page can call it (see the comment on the route), and it serves
 * apps/api/src/config/plans.ts — the single source of truth. Nothing here may
 * hard-code a price, a quota or a storage size: a price change must be a
 * one-line edit in that config, and this follows.
 *
 * Client-side fetch, not SSR: the landing page is already dynamic (it reads the
 * CSP nonce header) and blocking its render on an API round trip would put the
 * hero behind the API's latency. The block degrades to a skeleton and then, if
 * the API is unreachable, to a link — the page above it never depends on this.
 *
 * NO PURCHASE CTA. Payment is not live (POST /plans/change is 503'd until a
 * verified payment webhook exists), so the only action here is the free one:
 * add the OA. Three disabled "อัปเกรด" buttons would be three dead ends.
 */

/** Same rows, same labels, same order as /dashboard/plans. */
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
];

/**
 * The boolean gates worth showing a first-time visitor. Deliberately SHORTER
 * than the account page's list: the support SLA and the onboarding call answer
 * questions nobody has before they have used the product once.
 */
const FEATURE_ROWS: { feature: string; label: string }[] = [
  { feature: 'export_task_summary', label: 'ดาวน์โหลดสรุปงาน (Excel)' },
  { feature: 'google_sheets', label: 'เชื่อม Google Sheets' },
  { feature: 'performance_report', label: 'รายงานผลการทำงานรายบุคคล' },
];

/** -1 is the UNLIMITED sentinel from config/plans.ts. */
function limitText(n: number | undefined, unit: string): string {
  if (n === undefined) return '—';
  if (n < 0) return 'ไม่จำกัด';
  return `${n.toLocaleString('th-TH')} ${unit}`;
}

function baht(amount: number): string {
  return `${amount.toLocaleString('th-TH')} บาท`;
}

/**
 * ราคาก่อนลด (compare-at) — the ONLY numbers in this block that do not come from
 * the API, and the one place it deliberately duplicates /dashboard/plans instead
 * of importing: they are a marketing anchor, not a price the system ever charged,
 * so config/plans.ts has no field for them (adding one would imply the billing
 * code could bill it) and a page file is not a module to import constants from.
 * KEEP THESE TWO TABLES IN STEP — the account page's copy is the reference.
 * Monthly figures only; the yearly anchor is 10×, the same "two months free"
 * shape as the real yearly price.
 */
const COMPARE_AT_MONTHLY: Record<string, number> = {
  pro: 109,
  premium: 259,
};

/** The struck-through anchor above the price, or null when there isn't one. */
function compareAtText(plan: PlanSummaryDto, cycle: BillingCycle): string | null {
  const monthly = COMPARE_AT_MONTHLY[plan.plan];
  if (!monthly || plan.pricing.monthly <= 0) return null;
  return baht(cycle === 'monthly' ? monthly : monthly * 10);
}

function priceText(plan: PlanSummaryDto, cycle: BillingCycle): string {
  if (plan.pricing.monthly === 0) return 'ฟรี';
  const amount = cycle === 'monthly' ? plan.pricing.monthly : plan.pricing.yearly;
  if (amount === null) return '—';
  return `${baht(amount)}/${cycle === 'monthly' ? 'เดือน' : 'ปี'}`;
}

/** The other cycle's figure, so either tab shows what the alternative costs. */
function priceSubLabel(plan: PlanSummaryDto, cycle: BillingCycle): string | null {
  if (plan.pricing.monthly <= 0 || plan.pricing.yearly === null) return null;
  if (cycle === 'monthly') return `${baht(plan.pricing.yearly)}/ปี`;
  return `เฉลี่ย ${baht(Math.round(plan.pricing.yearly / 12))}/เดือน`;
}

export default function PlansSection() {
  const [plans, setPlans] = useState<PlanSummaryDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  // รายปี leads — it is the better deal, same default as /dashboard/plans.
  const [cycle, setCycle] = useState<BillingCycle>('yearly');

  useEffect(() => {
    let alive = true;
    getPlans()
      .then((res) => {
        if (alive) setPlans(res.plans);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (failed) {
    return (
      <p className={s.failed}>
        ตอนนี้หนูดึงตารางแพลนมาไม่ได้น้า —{' '}
        <Link href="/dashboard/plans">เปิดหน้าแพลนทั้งหมด</Link> ดูได้เลย
      </p>
    );
  }

  if (!plans) {
    return (
      <div className={s.skeletonGrid} aria-hidden="true">
        <div className={s.skeleton} />
        <div className={s.skeleton} />
        <div className={s.skeleton} />
      </div>
    );
  }

  return (
    <>
      <div className={s.toggleRow}>
        <div className={card.cycleToggle} role="group" aria-label="รอบการชำระเงิน">
          <button
            type="button"
            className={cycle === 'yearly' ? card.cycleActive : card.cycleBtn}
            onClick={() => setCycle('yearly')}
            aria-pressed={cycle === 'yearly'}
          >
            รายปี
            <span className={card.cycleSave}>ประหยัด 2 เดือน</span>
          </button>
          <button
            type="button"
            className={cycle === 'monthly' ? card.cycleActive : card.cycleBtn}
            onClick={() => setCycle('monthly')}
            aria-pressed={cycle === 'monthly'}
          >
            รายเดือน
          </button>
        </div>
      </div>

      <div className={`${card.cards} ${s.cards}`}>
        {plans.map((plan) => {
          // Pro is the recommended tier — the first paid step, and the one that
          // covers the limits most groups actually hit.
          const recommended = plan.plan === 'pro';
          const compareAt = compareAtText(plan, cycle);
          const subLabel = priceSubLabel(plan, cycle);
          return (
            <section
              key={plan.plan}
              className={`${card.card} ${recommended ? card.cardRecommended : ''}`}
            >
              {recommended && <span className={card.badgeRecommended}>แนะนำ</span>}

              {/* No emoji on tier names — brand rule. Name comes from the API. */}
              <h3 className={card.cardName}>{plan.displayName}</h3>

              {/* Same spacer trick as the note below: the free tier has no
                  anchor, so the tag renders hidden and holds the line. */}
              <div
                className={card.priceCompare}
                style={compareAt ? undefined : { visibility: 'hidden' }}
                aria-hidden={compareAt ? undefined : true}
              >
                {compareAt ?? '— บาท'}
              </div>
              <div className={card.priceRow}>
                <span className={card.price}>{priceText(plan, cycle)}</span>
              </div>
              {/* The free tier has no second cycle, so its note is a spacer:
                  hidden but occupying the line, which keeps the three price
                  blocks the same height without a fixed pixel value. */}
              <div
                className={card.priceNote}
                style={subLabel ? undefined : { visibility: 'hidden' }}
                aria-hidden={subLabel ? undefined : true}
              >
                {subLabel ?? '— บาท/ปี'}
              </div>

              <div className={card.storage}>
                พื้นที่ {formatBytes(plan.lockerBytes)}
                {plan.features.referral_storage_bonus &&
                  plan.lockerMaxBytesWithReferrals > plan.lockerBytes &&
                  ` (ชวนเพื่อนเพิ่มได้ถึง ${formatBytes(plan.lockerMaxBytesWithReferrals)})`}
              </div>

              <ul className={card.featureList}>
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
                {FEATURE_ROWS.map((row) => (
                  <li key={row.feature} className={plan.features[row.feature] ? '' : card.featureOff}>
                    <span>{row.label}</span>
                    <b>{plan.features[row.feature] ? 'ใช้ได้' : '—'}</b>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      <div className={s.cta}>
        <a href={LINE_ADD_FRIEND_URL} className={s.ctaBtn}>
          <IcoChat />
          เริ่มต้นฟรี — ไม่ต้องสมัคร
        </a>
        <p className={s.note}>
          แพลนแบบเสียเงินยังไม่เปิดให้ชำระเงินน้า — ตอนนี้เริ่มที่แพลนฟรีได้เลย
          แล้วค่อยขยับขึ้นตอนใช้หนักขึ้น · <Link href="/dashboard/plans">ดูตารางแพลนแบบเต็ม</Link>
        </p>
      </div>
    </>
  );
}

function IcoChat() {
  return (
    <svg width={19} height={19} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 3.5c-5 0-9 3.2-9 7.2 0 2.3 1.3 4.3 3.4 5.6l-.8 3.3c-.1.4.3.7.7.5l3.8-2.1c.6.1 1.2.2 1.9.2 5 0 9-3.2 9-7.2s-4-7.5-9-7.5Z" />
    </svg>
  );
}
