'use client';

import { useState } from 'react';
import type { SheetsTrialStatus } from '@nookeb/shared';
import { ApiError, activateSheetsTrial } from '@/lib/api';
import { formatThaiDate } from '@/lib/format';
import { PLAN_DISPLAY_NAME } from '@/lib/quota-errors';
import { SHEETS_PERKS } from './perks';
import styles from './TrialBanner.module.css';

/**
 * หนูเก็บลองงาน — the trial's state, what it is worth, and where the user is
 * in the two things they have to do.
 *
 * FOUR STATES, and they are not a two-way toggle. "Never activated" and
 * "expired" are different situations needing different copy and different
 * controls: one offers a free trial, the other must not, because the trial is
 * once per account forever and offering it again would promise something the
 * server will refuse with a 409.
 *
 *   never started  the offer, what it buys, and an activate button
 *   running        days left + the meter + the step still outstanding
 *   last 3 days    the same, amber, plus the upgrade path
 *   expired        what stopped, when, and the upgrade path
 *
 * WHY THE STEP STRIP EXISTS. Activating the trial and connecting Google are two
 * separate actions in two separate blocks, and the old banner said nothing
 * about the second one — a user who pressed "เริ่มทดลองใช้" got a green strip
 * and no indication that the feature still does nothing until they connect. The
 * strip names all three steps in every state, so the page answers "what now?"
 * on its own. That is the whole discoverability fix; the tints were already
 * fine.
 *
 * The component RENDERS server state and never computes it. `daysRemaining`
 * arrives from the API; deriving it here from `expiresAt` would let a wrong
 * device clock show a countdown that disagrees with the one actually enforcing
 * the cutoff. The meter's WIDTH is days ÷ trialDays — a second reading of two
 * served numbers, not a third opinion about the date.
 *
 * It renders nothing at all when access comes from the user's PLAN — a premium
 * subscriber has no trial to think about, and a countdown next to a permanent
 * entitlement is just alarming.
 */

/** Amber below this many days left. Cosmetic only — no behaviour changes. */
const ENDING_SOON_DAYS = 3;

/**
 * The user's whole path, named once. Step 3 is not an action they take — it is
 * what happens once they have taken the first two, and it is in the list
 * because "then what?" is the question the offer has to answer to be worth
 * taking.
 */
const STEPS = ['เริ่มทดลองใช้', 'เชื่อม Google Sheet', 'หนู sync ให้อัตโนมัติ'];

function FlaskIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M10 3h4M10.5 3v6.2L5.6 17.4A2 2 0 0 0 7.3 20.5h9.4a2 2 0 0 0 1.7-3.1L13.5 9.2V3"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8 15h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4.75" y="10.25" width="14.5" height="10" rx="2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M8.25 10V7.5a3.75 3.75 0 0 1 7.5 0V10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden className={styles.perkIcon}>
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

/** 1 = not started · 2 = trial live, not connected · 3 = connected and syncing. */
type StepNumber = 1 | 2 | 3;

function Steps({ current }: { current: StepNumber }) {
  return (
    <ol className={styles.steps}>
      {STEPS.map((label, i) => {
        const n = i + 1;
        const state = n < current ? styles.stepDone : n === current ? styles.stepNow : styles.stepNext;
        return (
          <li
            key={label}
            className={`${styles.step} ${state}`}
            aria-current={n === current ? 'step' : undefined}
          >
            <span className={styles.stepNum} aria-hidden>
              {n}
            </span>
            <span>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

export interface TrialBannerProps {
  status: SheetsTrialStatus;
  /**
   * Is Google actually linked? Only the step strip reads it — the trial and the
   * connection are independent facts, and a live trial with nothing connected
   * is the state this redesign exists to make visible.
   */
  connected?: boolean;
  /** Called after a successful activation so the parent can refetch. */
  onActivated: () => void;
  /** Opens the plan upgrade card — the expired state's only forward path. */
  onUpgrade: () => void;
  disabled?: boolean;
}

export function TrialBanner({
  status,
  connected = false,
  onActivated,
  onUpgrade,
  disabled,
}: TrialBannerProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { trial, access, trialDays, name } = status;

  // Entitled by plan → nothing to say. See the component doc.
  if (access.source === 'plan') return null;

  const activate = async () => {
    setBusy(true);
    setError(null);
    try {
      await activateSheetsTrial();
      onActivated();
    } catch (err) {
      // Both 409s are real answers, not failures to retry — say what happened
      // and stop offering the button by refetching.
      if (err instanceof ApiError && err.status === 409) {
        // The API's Thai copy says which 409 this is (already used vs already
        // entitled). ApiError.message is '' when the body carried only a code,
        // so it is never rendered bare.
        setError(err.message || 'เริ่มทดลองใช้ไม่ได้แล้วน้า');
        onActivated();
      } else if (err instanceof ApiError && err.status === 503) {
        setError('ยังไม่เปิดให้ทดลองใช้ตอนนี้น้า');
      } else {
        setError('เริ่มทดลองใช้ไม่สำเร็จน้า ลองใหม่อีกทีนะ');
      }
      setBusy(false);
    }
  };

  // ---- expired ----------------------------------------------------------
  if (trial.isExpired) {
    const endedOn = formatThaiDate(trial.expiresAt);
    return (
      <section className={`${styles.panel} ${styles.expired}`} role="status">
        <div className={styles.head}>
          <span className={styles.headIcon}>
            <LockIcon />
          </span>
          <div className={styles.headText}>
            <p className={styles.eyebrow}>{name}</p>
            <h3 className={styles.title}>หมดอายุแล้ว</h3>
            <p className={styles.sub}>
              หนูหยุด sync ให้แล้วน้า — Sheet เดิมของพี่ยังอยู่ครบทุกแถว ไม่ได้หายไปไหน
            </p>
            {/* The date, not "N วันที่แล้ว": this is the fact a user checks
                against their own records, and it is the last thing the trial
                has to say for itself. */}
            {endedOn && <p className={styles.fine}>หมดอายุเมื่อ {endedOn}</p>}
          </div>
        </div>
        <div className={styles.actions}>
          <button className="btn small" onClick={onUpgrade} disabled={disabled}>
            อัปเกรดเป็น {PLAN_DISPLAY_NAME.premium} →
          </button>
        </div>
      </section>
    );
  }

  // ---- running ----------------------------------------------------------
  if (trial.isActive) {
    const days = trial.daysRemaining ?? 0;
    const ending = days <= ENDING_SOON_DAYS;
    // Served ÷ served. Clamped because a 0-day plan config would divide by zero
    // and a server that ever returns days > trialDays must not overflow the bar.
    const pct = trialDays > 0 ? Math.min(100, Math.max(0, Math.round((days / trialDays) * 100))) : 0;
    const until = formatThaiDate(trial.expiresAt);

    return (
      <section
        className={`${styles.panel} ${ending ? styles.ending : styles.active}`}
        role="status"
      >
        <div className={styles.head}>
          <span className={styles.headIcon}>
            <FlaskIcon />
          </span>
          <div className={styles.headText}>
            <p className={styles.eyebrow}>{name} · กำลังทดลองใช้</p>
            <h3 className={styles.title}>เหลืออีก {days} วัน</h3>
            <p className={styles.sub}>
              {connected
                ? 'เชื่อม Google Sheet แล้ว หนู sync งานให้อัตโนมัติอยู่น้า'
                : 'เหลืออีกขั้นเดียว — กดเชื่อมต่อ Google Sheets ด้านล่างได้เลยน้า'}
            </p>
          </div>
        </div>

        <div
          className={styles.meter}
          role="img"
          aria-label={`เหลืออีก ${days} วัน จากทั้งหมด ${trialDays} วัน`}
        >
          <span className={styles.meterFill} style={{ width: `${pct}%` }} />
        </div>

        {until && (
          <p className={styles.fine}>
            {ending
              ? `ครบกำหนด ${until} แล้วหนูจะหยุด sync และคืนสิทธิ์ Google ให้อัตโนมัติน้า`
              : `ใช้ได้ถึง ${until}`}
          </p>
        )}

        <Steps current={connected ? 3 : 2} />

        {ending && (
          <div className={styles.actions}>
            <button className="btn secondary small" onClick={onUpgrade} disabled={disabled}>
              อัปเกรดเพื่อใช้ต่อ →
            </button>
          </div>
        )}
      </section>
    );
  }

  // ---- never started ----------------------------------------------------
  // `canActivate` is the server's answer, not ours: it is false once the
  // one-shot is spent and false when the plan already includes Sheets.
  if (!status.canActivate) return null;

  return (
    <section className={`${styles.panel} ${styles.offer}`} aria-labelledby="sheets-trial-offer">
      <div className={styles.head}>
        <span className={styles.headIcon}>
          <FlaskIcon />
        </span>
        <div className={styles.headText}>
          <p className={styles.eyebrow}>{name}</p>
          <h3 id="sheets-trial-offer" className={styles.title}>
            ทดลองเชื่อม Google Sheets ฟรี {trialDays} วัน
          </h3>
          <p className={styles.sub}>ไม่มีค่าใช้จ่าย ไม่ต้องผูกบัตร กดเริ่มได้เลยน้า</p>
        </div>
      </div>

      {/* Same three lines the upgrade card lists (components/SheetsTrial/perks)
          — the offer and the paid pitch must not describe different products. */}
      <ul className={styles.perks}>
        {SHEETS_PERKS.map((perk) => (
          <li key={perk} className={styles.perk}>
            <CheckIcon />
            <span>{perk}</span>
          </li>
        ))}
      </ul>

      <Steps current={1} />

      <div className={styles.actions}>
        <button className="btn" onClick={() => void activate()} disabled={busy || disabled}>
          {busy ? 'กำลังเริ่ม...' : `เริ่มทดลองใช้ฟรี ${trialDays} วัน`}
        </button>
      </div>

      <p className={styles.fine}>
        ใช้ได้ครั้งเดียวต่อบัญชี · ครบ {trialDays} วันแล้วหนูจะหยุด sync ให้เองน้า ไม่มีการตัดเงินต่อ
      </p>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export default TrialBanner;
