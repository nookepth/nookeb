'use client';

import { useEffect, useRef, useState } from 'react';
import {
  getReferralStatus,
  redeemReferralCode,
  ApiError,
  type ReferralStatusResponse,
} from '@/lib/api';

/** Referrals for the top tier — the scale the bar is drawn against. NOT a cap:
 * the count keeps rising past it, it just stops unlocking storage. Mirrors
 * TOP_TIER_REFERRALS in the API's referral.service.ts. */
const TOP_TIER_REFERRALS = 5;

/** Milestone dots: 3/5 referrals at 60%/100% of the 0→5 bar. */
const MILESTONES = [3, 5] as const;
const MILESTONE_POS: Record<number, number> = { 3: 60, 5: 100 };

/** Label rendered ABOVE each milestone dot (\n → line breaks via pre-line). */
const MILESTONE_LABEL: Record<number, string> = {
  3: 'ครบ 3 คน\nรับ 2.5 GB',
  5: 'ครบ 5 คน\nได้ 4 GB',
};

/** Dynamic motivational line keyed by the EXACT referral count.
 * Must stay in sync with flex.service.ts `referralMotivationalText`. */
function getMotivationalText(count: number): string {
  switch (count) {
    case 0:
      return 'เริ่มชวนเพื่อนรับรางวัลพิเศษไปเลย! ❤️';
    case 1:
      return 'อีก 2 คน ได้ 2.5 GB เลยน้า ❤️';
    case 2:
      return 'ขาดแค่คนเดียวจะได้ 2.5 GB แล้วววว 🔥';
    case 3:
      return 'ได้ 2.5 GB แล้ว! ชวนต่อได้อีกนะ อีก 2 คน ได้ 4 GB 📂';
    case 4:
      return 'อีกคนเดียว! ได้ 4 GB เลยยย 💪';
    default:
      return 'เจ๋งที่สุดไปเลยย! ได้ 4 GB เต็มๆ แล้ว 🏆📁';
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
      requestAnimationFrame(() =>
        setBarPct(Math.min(100, (s.referralCount / TOP_TIER_REFERRALS) * 100)),
      ),
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

      {process.env.NODE_ENV === 'development' && (
        <p style={{ fontSize: '10px', color: '#999' }}>
          debug: referredById={String(status.referredById)} count={status.referralCount}
        </p>
      )}

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

      {/* The bar is always rendered — there is no referral cap. Past the top
          tier (5) it simply stays full while the count keeps climbing. */}
      <div className="referral-bar-row">
        <div className="referral-track">
          <div className="referral-fill" style={{ width: `${barPct}%` }} />
          {/* Each milestone: label + dot share ONE left:% anchor so the
              label centers exactly above its dot (both use translateX(-50%)). */}
          {MILESTONES.map((m) => (
            <div
              key={m}
              className="referral-milestone"
              style={{ left: `${MILESTONE_POS[m]}%` }}
            >
              <span
                className={`referral-label ${status.referralCount >= m ? 'reached' : ''}`}
              >
                {MILESTONE_LABEL[m]}
              </span>
              <span
                className={`referral-marker ${status.referralCount >= m ? 'passed' : ''}`}
              />
            </div>
          ))}
          {/* Current referral count marker */}
          <span className="referral-cursor" style={{ left: `${barPct}%` }} />
        </div>
        <span className="referral-count">{status.referralCount} คน</span>
      </div>

      {/* Fix 2 — dynamic motivational text below the bar */}
      <p className="referral-motivation">{getMotivationalText(status.referralCount)}</p>
    </div>
  );
}
