'use client';

import { useEffect, useRef, useState } from 'react';
import {
  getReferralStatus,
  redeemReferralCode,
  ApiError,
  type ReferralStatusResponse,
} from '@/lib/api';

/** Milestone dots: 3/5/7/10 referrals at 30%/50%/70%/100% of the 0→10 bar. */
const MILESTONES = [3, 5, 7, 10] as const;
const MILESTONE_POS: Record<number, number> = { 3: 30, 5: 50, 7: 70, 10: 100 };

/** Label rendered ABOVE each milestone dot (\n → line breaks via pre-line). */
const MILESTONE_LABEL: Record<number, string> = {
  3: 'ครบ 3 คน\nรับ 3 GB',
  5: 'ครบ 5 คน\nได้ 5 GB',
  7: 'ครบ 7 คน\nรับ 7 GB',
  10: 'เจ๋งที่สุด\nรับ 10 GB',
};

/** Dynamic motivational line keyed by the EXACT referral count (0–10+).
 * Must stay in sync with flex.service.ts `referralMotivationalText`. */
function getMotivationalText(count: number): string {
  switch (count) {
    case 0:
      return 'เริ่มชวนเพื่อนรับรางวัลพิเศษไปเลย! ❤️';
    case 1:
      return 'อีก 2 คน ได้ 3 GB เลยน้า ❤️';
    case 2:
      return 'ขาดแค่คนเดียวจะได้ 3 GB แล้วววว 🔥';
    case 3:
      return 'ได้ 3 GB แล้ว! ชวนต่อได้อีกนะ อีก 2 คน ได้ 5 GB 📂';
    case 4:
      return 'อีกคนเดียว! ได้ 5 GB เลยยย 💪';
    case 5:
      return 'ได้ 5 GB แล้ว เก่งมาก! อีก 2 คน ได้ 7 GB ⭐';
    case 6:
      return 'อีกคนเดียวได้ 7 GB แล้วนะ สู้ๆ 🌟';
    case 7:
      return 'ได้ 7 GB แล้ว! ยอดเยี่ยมมาก อีก 3 คน รับ 10 GB เลย';
    case 8:
      return 'อีก 2 คน ได้ 10 GB เต็มๆ เลย! 🏆';
    case 9:
      return 'อีกคนเดียวเท่านั้น! 10 GB รออยู่นะ 👑';
    default:
      return 'เจ๋งที่สุดไปเลยย! ได้ 10 GB เต็มๆ แล้ว 🏆📁';
  }
}

type CopyState = 'idle' | 'copied' | 'error';
type RedeemState = 'idle' | 'loading' | 'success';

export function ReferralCard() {
  const [status, setStatus] = useState<ReferralStatusResponse | null>(null);
  const [error, setError] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  // bar starts at 0 and transitions to the real value on mount (CSS 0.6s ease)
  const [barPct, setBarPct] = useState(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Redeem input (Fix 4B)
  const [redeemCodeInput, setRedeemCodeInput] = useState('');
  const [redeemState, setRedeemState] = useState<RedeemState>('idle');
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function applyStatus(s: ReferralStatusResponse): void {
    setStatus(s);
    // next frame so the 0-width bar paints first, then animates to the value
    requestAnimationFrame(() =>
      requestAnimationFrame(() => setBarPct(Math.min(100, (s.referralCount / 10) * 100))),
    );
  }

  useEffect(() => {
    getReferralStatus()
      .then(applyStatus)
      .catch((err) => {
        console.error('referral status error:', err);
        setError(true);
      });
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
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

  async function handleRedeem(): Promise<void> {
    const code = redeemCodeInput.trim();
    if (!code || redeemState === 'loading') return;
    setRedeemState('loading');
    setRedeemError(null);
    try {
      const res = await redeemReferralCode(code);
      if (!res.ok) {
        setRedeemError(res.message ?? 'กรอกโค้ดไม่สำเร็จ ลองใหม่นะคะ');
        setRedeemState('idle');
        return;
      }
      setRedeemState('success');
      // Refetch after a beat so the success message is visible, then the input
      // section hides itself (referredById is now set).
      refetchTimer.current = setTimeout(() => {
        getReferralStatus().then(applyStatus).catch(() => {});
      }, 1500);
    } catch (err) {
      const msg =
        err instanceof ApiError && err.status === 429
          ? 'ลองใหม่ใน 1 ชั่วโมงนะคะ'
          : 'เกิดข้อผิดพลาด ลองใหม่อีกทีนะคะ';
      setRedeemError(msg);
      setRedeemState('idle');
    }
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
  const alreadyRedeemed = status.referredById !== null;

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

      {/* Fix 4B — redeem a friend's code (only if this user hasn't redeemed one) */}
      {alreadyRedeemed ? (
        <p className="referral-redeemed-note">✅ กรอกโค้ดเพื่อนไปแล้ว ได้ +0.5 GB</p>
      ) : redeemState === 'success' ? (
        <p className="referral-redeem-success">🎉 ได้รับ +0.5 GB แล้ว!</p>
      ) : (
        <div className="referral-redeem">
          <div className="referral-redeem-label">มีโค้ดเชิญจากเพื่อนไหม?</div>
          <div className="referral-redeem-row">
            <input
              className="referral-redeem-input"
              type="text"
              autoCapitalize="characters"
              autoComplete="off"
              maxLength={8}
              placeholder="พิมพ์โค้ดที่นี่"
              value={redeemCodeInput}
              onChange={(e) => setRedeemCodeInput(e.target.value.toUpperCase().slice(0, 8))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleRedeem();
              }}
              disabled={redeemState === 'loading'}
            />
            <button
              className="btn primary small"
              onClick={() => void handleRedeem()}
              disabled={redeemState === 'loading' || redeemCodeInput.trim().length === 0}
            >
              {redeemState === 'loading' ? 'กำลังตรวจสอบ...' : 'รับพื้นที่'}
            </button>
          </div>
          {redeemError ? (
            <p className="referral-redeem-error">{redeemError}</p>
          ) : (
            <p className="referral-redeem-hint">กรอกโค้ดเพื่อนรับพื้นที่เพิ่ม 0.5 GB</p>
          )}
        </div>
      )}

      {atMax ? (
        <p className="referral-max">🏆 เต็มแล้ว! คุณได้พื้นที่สูงสุด 10 GB แล้ว!</p>
      ) : (
        <>
          {/* Milestone labels ABOVE the dots */}
          <div className="referral-labels">
            {MILESTONES.map((m) => (
              <span
                key={m}
                className={`referral-label ${status.referralCount >= m ? 'reached' : ''}`}
                style={{ left: `${MILESTONE_POS[m]}%` }}
              >
                {MILESTONE_LABEL[m]}
              </span>
            ))}
          </div>

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
              {/* Current referral count marker */}
              <span className="referral-cursor" style={{ left: `${barPct}%` }} />
            </div>
            <span className="referral-count">{status.referralCount}/10 คน</span>
          </div>

          {/* Fix 2 — dynamic motivational text below the bar */}
          <p className="referral-motivation">{getMotivationalText(status.referralCount)}</p>
        </>
      )}
    </div>
  );
}
