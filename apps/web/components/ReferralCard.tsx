'use client';

import { useEffect, useRef, useState } from 'react';
import { getReferralStatus, type ReferralStatusResponse } from '@/lib/api';

const MILESTONES = [1, 4, 7, 10] as const;
/** overall bar positions of the 1/4/7/10 milestones (10 referrals = 100%) */
const MILESTONE_POS: Record<number, number> = { 1: 10, 4: 40, 7: 70, 10: 100 };

/** Milestone teaser lines — same exact copy the LINE bot sends
 * (flex.service.ts referralMilestoneText), keyed by the milestone count. */
const MILESTONE_LINE: Record<number, string> = {
  1: '3 คนแย้วน้า 🥳 อีกหน่อยได้ 3 GB แน่ๆ!',
  4: '5 คนแย้วสู้ๆ 💪 ใกล้ได้ 5 GB แล้ว!',
  7: '7 คนแย้วเจ๋งมาก 🌟 อีกนิดเดียว!',
  10: '10 คนแย้วสุดเจ๋ง 🏆 ได้ 10 GB เต็มๆ แล้ว!',
};

type CopyState = 'idle' | 'copied' | 'error';

export function ReferralCard() {
  const [status, setStatus] = useState<ReferralStatusResponse | null>(null);
  const [error, setError] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  // bar starts at 0 and transitions to the real value on mount (CSS 0.6s ease)
  const [barPct, setBarPct] = useState(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    getReferralStatus()
      .then((s) => {
        setStatus(s);
        // next frame so the 0-width bar paints first, then animates to the value
        requestAnimationFrame(() =>
          requestAnimationFrame(() => setBarPct(Math.min(100, (s.referralCount / 10) * 100))),
        );
      })
      .catch(() => setError(true));
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  async function handleCopy(): Promise<void> {
    if (!status) return;
    try {
      await navigator.clipboard.writeText(status.code);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyState('idle'), 2000);
  }

  if (error) {
    return (
      <div className="referral">
        <div className="referral-title">📁 ชวนเพื่อน รับพื้นที่เพิ่ม</div>
        <p className="referral-error">โหลดไม่ได้ ลองรีเฟรชนะคะ 📋</p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="referral" aria-busy="true">
        <div className="referral-title">📁 ชวนเพื่อน รับพื้นที่เพิ่ม</div>
        <div className="skeleton referral-skeleton-code" />
        <div className="skeleton referral-skeleton-line" />
      </div>
    );
  }

  const atMax = status.nextTierGB === null;
  const nextMilestone = MILESTONES.find((m) => m > status.referralCount) ?? null;

  return (
    <div className="referral">
      <div className="referral-title">📁 ชวนเพื่อน รับพื้นที่เพิ่ม</div>

      <div className="referral-code-label">โค้ดของคุณ</div>
      <div className="referral-code-row">
        <span className="referral-code">{status.code}</span>
        <button className="btn secondary small" onClick={() => void handleCopy()}>
          {copyState === 'copied' ? 'คัดลอกแล้ว! ✓' : copyState === 'error' ? 'ลองใหม่อีกครั้ง' : 'คัดลอก'}
        </button>
      </div>

      {atMax ? (
        <p className="referral-max">🏆 เต็มแล้ว! คุณได้พื้นที่สูงสุด 10 GB แล้ว!</p>
      ) : (
        <>
          <div className="referral-bar-row">
            <div className="referral-track">
              <div className="referral-fill" style={{ width: `${barPct}%` }} />
              {MILESTONES.map((m) => (
                <span
                  key={m}
                  className={`referral-marker ${status.referralCount >= m ? 'passed' : ''}`}
                  style={{ left: `${MILESTONE_POS[m]}%` }}
                />
              ))}
            </div>
            <span className="referral-count">{status.referralCount}/10 คน</span>
          </div>

          {nextMilestone !== null && (
            <p className="referral-milestone">{MILESTONE_LINE[nextMilestone]}</p>
          )}
          <p className="referral-next">
            อีก {status.neededForNext} คน → ได้ {status.nextTierGB} GB เพิ่ม 📂
          </p>
        </>
      )}
    </div>
  );
}
