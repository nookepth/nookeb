'use client';

import { PLAN_DISPLAY_NAME } from '@/lib/quota-errors';
import styles from './tasks.module.css';

/**
 * "Export Excel ต้องใช้แพลน Pro ขึ้นไป" — the friendly half of the §14 plan gate.
 *
 * Why this exists: GET /tasks/export is reached by a TOP-LEVEL navigation (the
 * session lives in an HttpOnly cookie, so a download link is the only
 * authenticated path — see handleExport). That means the API's 403
 * `{"error":"PLAN_UPGRADE_REQUIRED",…}` was rendered by the browser as raw JSON
 * on a blank white page, and the user lost the task list they were looking at.
 *
 * So free users never start that navigation: the button opens this instead. The
 * server gate is untouched and still the real boundary — this is only the copy
 * a person deserves in front of it.
 *
 * Deliberately NOT the shared ProLockModal: that one is a fake door (its CTA
 * records demand for a feature that does not exist). Export is built and
 * purchasable, so the CTA is a real link to the plans page.
 *
 * Brand rule: no emoji — the lock and the sheet are inline SVG.
 */

function LockedSheetGlyph() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 48 48" fill="none" aria-hidden>
      {/* sheet */}
      <path
        d="M11 6.5h16.5L37 16v25.5H11z"
        fill="#fff"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <path d="M27 6.5V16h10" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
      <path
        d="M16.5 22.5h15M16.5 28h15M16.5 33.5h7"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity="0.45"
      />
      {/* padlock badge */}
      <circle cx="34" cy="34" r="10.5" fill="currentColor" />
      <rect x="29.6" y="33.4" width="8.8" height="6.4" rx="1.6" fill="#fff" />
      <path
        d="M31.6 33.4v-1.7a2.4 2.4 0 0 1 4.8 0v1.7"
        stroke="#fff"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="m5 12.5 4.5 4.5L19 7.5"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** What the user actually buys — concrete, not "unlock premium features". */
const PERKS = [
  'ดาวน์โหลดงานทั้งหมดเป็นไฟล์ .xlsx แถวละรายการ',
  'มีวันครบกำหนด ผู้รับผิดชอบ และสถานะครบทุกคอลัมน์',
  'เชื่อม Google Sheets ให้อัปเดตเองอัตโนมัติ',
];

export default function ExportUpgradeModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className={styles.modalOverlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-upgrade-title"
      onClick={onClose}
    >
      <div
        className={`${styles.modal} ${styles.upgradeModal}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.upgradeIcon}>
          <LockedSheetGlyph />
        </div>

        <span className={styles.upgradeTag}>ต้องใช้แพลน {PLAN_DISPLAY_NAME.pro} ขึ้นไป</span>
        <h2 id="export-upgrade-title" className={styles.upgradeTitle}>
          ฟีเจอร์นี้ต้องการแพลน Pro ขึ้นไปน้า
        </h2>
        <p className={styles.upgradeText}>
          หนูสรุปงานทุกกลุ่มเป็นไฟล์ Excel ให้ได้เลย — อัปเกรดแล้วกดปุ่มเดียวจบน้า
        </p>

        <ul className={styles.upgradePerks}>
          {PERKS.map((perk) => (
            <li key={perk} className={styles.upgradePerk}>
              <span className={styles.upgradePerkIcon}>
                <CheckGlyph />
              </span>
              {perk}
            </li>
          ))}
        </ul>

        <div className={styles.upgradeActions}>
          <a className={styles.upgradePrimary} href="/dashboard/plans">
            ดูแพลนทั้งหมด
          </a>
          <button type="button" className={styles.upgradeSecondary} onClick={onClose}>
            ไว้ก่อนน้า
          </button>
        </div>
      </div>
    </div>
  );
}
