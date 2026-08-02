'use client';

import type { GoogleIntegrationStatus } from '@/lib/api';
import { formatThaiDateTime } from '@/lib/format';
import styles from './ConnectSheet.module.css';

/**
 * The Google Sheets connection controls, gated on entitlement (migration 062).
 *
 * Entitlement here means "premium plan OR live หนูเก็บลองงาน trial" — the same
 * question resolveSheetsAccess answers on the server, and the server's answer is
 * the one that counts. This component is presentation: every path it offers is
 * re-checked by sheetsTrialGuard on the request, so a user who edits
 * `entitled` in devtools reaches a 403, not a connection.
 *
 * WHAT THE LOCKED STATE MUST NOT DO — the spec is explicit and it matches how
 * the rest of this dashboard behaves: dim this section, and touch nothing else.
 * No redirect, no interstitial, no effect on files, diary, vault, tasks or any
 * other page. Losing a trial of one integration is not losing the product.
 *
 * WHAT IT MUST DO — say which lock this is. "ต้องมีสิทธิ์ใช้งานก่อน" is true for
 * a user whose trial expired AND for one who has a free trial sitting unclaimed
 * two inches above the sentence, and for the second user it reads as a wall
 * when it is actually a next step. `lockReason` is what tells them apart.
 */

function LockIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden className={styles.lockIcon}>
      <rect x="4.75" y="10.25" width="14.5" height="10" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8.25 10V7.5a3.75 3.75 0 0 1 7.5 0V10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden className={styles.lockIcon}>
      <path d="M12 19.5V5m0 0-6 6m6-6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Recency for a sync that just happened, an absolute Thai date for one that
 * did not. "3 วันที่แล้ว" answers the wrong question past a day — by then the
 * user is checking a specific run against their own records, and needs the date
 * the rest of this page shows.
 */
function formatWhen(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'เมื่อสักครู่';
  if (mins < 60) return `${mins} นาทีที่แล้ว`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ชั่วโมงที่แล้ว`;
  return formatThaiDateTime(iso);
}

/**
 * Why the controls are locked. Read only when `entitled` is false.
 * 'trial-available' = a free trial is still unclaimed, so this is step 2 of a
 * path the user is already on. 'upgrade' = nothing left to claim.
 */
export type SheetsLockReason = 'trial-available' | 'upgrade';

export interface ConnectSheetProps {
  status: GoogleIntegrationStatus;
  /** Premium plan or a live trial. False → the dimmed, inert state. */
  entitled: boolean;
  lockReason?: SheetsLockReason;
  busy?: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onSyncHistorical: () => void;
}

export function ConnectSheet({
  status,
  entitled,
  lockReason = 'upgrade',
  busy,
  onConnect,
  onDisconnect,
  onSyncHistorical,
}: ConnectSheetProps) {
  // ---- no entitlement ---------------------------------------------------
  // Reached after a trial ends, or on a plan that never had access, or BEFORE
  // an unclaimed trial is started. The expiry sweep has already deleted the
  // credential by the time the first two show, so `connected` is false — but it
  // is rendered from the same props either way rather than assumed, because the
  // sweep runs up to 15 minutes after the cutoff and this must be honest during
  // that window.
  if (!entitled) {
    const pending = lockReason === 'trial-available';
    return (
      <div className={`${styles.locked} ${pending ? styles.pendingLock : ''}`} aria-disabled>
        <p className="settings-card-state">
          {status.connected
            ? 'หนูหยุด sync ให้แล้วน้า — กำลังคืนสิทธิ์ที่ขอไว้กับ Google'
            : 'ยังไม่ได้เชื่อมต่อ'}
        </p>
        <p className={styles.lockRow}>
          {pending ? <ArrowUpIcon /> : <LockIcon />}
          {pending
            ? 'กดเริ่มทดลองใช้ฟรีด้านบนก่อน แล้วปุ่มเชื่อมต่อจะเปิดให้ทันทีน้า'
            : 'เชื่อม Google Sheets ต้องมีสิทธิ์ใช้งานก่อนน้า'}
        </p>
      </div>
    );
  }

  // ---- connected --------------------------------------------------------
  if (status.connected) {
    return (
      <>
        <p className="settings-card-state connected">
          เชื่อมต่อแล้ว{status.email ? ` — ${status.email}` : ''}
        </p>
        {/* Labelled rows rather than bare sentences: connected is the state a
            user returns to in order to CHECK something (which file? synced
            when?), and a scannable label column answers that faster than prose
            wrapped across two lines on a phone. */}
        {status.sheetName && (
          <p className="settings-card-state">
            <span className={styles.rowLabel}>ไฟล์</span>
            <span className={styles.rowValue}>{status.sheetName}</span>
          </p>
        )}
        {status.lastError ? (
          <p className="settings-card-state bad">
            <span className={styles.rowLabel}>สถานะ</span>
            <span className={styles.rowValue}>{status.lastError}</span>
          </p>
        ) : status.lastSyncedAt ? (
          <p className="settings-card-state">
            <span className={styles.rowLabel}>sync ล่าสุด</span>
            <span className={styles.rowValue}>{formatWhen(status.lastSyncedAt)}</span>
          </p>
        ) : (
          <p className="settings-card-state">
            <span className={styles.rowLabel}>sync ล่าสุด</span>
            <span className={styles.rowValue}>
              ยังไม่เคย — Sheet จะถูกสร้างให้อัตโนมัติตอนพี่สร้างหรือแก้งานครั้งถัดไปน้า
            </span>
          </p>
        )}
        <div className="settings-card-actions">
          {status.sheetUrl && (
            <a
              className="btn secondary small"
              href={status.sheetUrl}
              target="_blank"
              rel="noreferrer"
            >
              เปิด Sheet ↗
            </a>
          )}
          <button className="btn secondary small" onClick={onSyncHistorical} disabled={busy}>
            sync ประวัติงาน
          </button>
          <button className="btn ghost small" onClick={onDisconnect} disabled={busy}>
            ยกเลิกการเชื่อมต่อ
          </button>
        </div>
        <p className="settings-card-note">
          ดึงงานที่สร้างไว้ก่อนเชื่อมต่อเข้ามาทีเดียว งานที่อยู่ใน Sheet แล้วหนูจะไม่เพิ่มซ้ำน้า
        </p>
      </>
    );
  }

  // ---- entitled, not yet connected --------------------------------------
  return (
    <>
      <p className="settings-card-state">ยังไม่ได้เชื่อมต่อ</p>
      <div className="settings-card-actions">
        <button className="btn" onClick={onConnect} disabled={busy}>
          {busy ? 'กำลังเปิด Google...' : 'เชื่อมต่อ Google Sheets →'}
        </button>
      </div>
      <p className="settings-card-note">
        หนูขอสิทธิ์แค่ Sheet ที่หนูสร้างเองเท่านั้น (drive.file) — ไฟล์อื่นใน Google Drive ของพี่
        หนูมองไม่เห็นน้า
      </p>
    </>
  );
}

export default ConnectSheet;
