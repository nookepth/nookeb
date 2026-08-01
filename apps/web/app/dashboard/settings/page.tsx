'use client';

import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import {
  ApiError,
  disconnectGoogle,
  getGoogleIntegration,
  getMe,
  hasSession,
  startGoogleConnect,
  syncGoogleHistorical,
  type GoogleIntegrationStatus,
} from '@/lib/api';
import { startLineLogin } from '@/lib/auth';
import { PLAN_DISPLAY_NAME } from '@/lib/quota-errors';
import { UpgradeModal } from '@/components/UpgradeModal';

/**
 * การเชื่อมต่อ — third-party integrations. Currently just Google Sheets
 * (migration 046); the page exists as its own route because the OAuth callback
 * has to redirect the browser SOMEWHERE with a result, and a dashboard section
 * with no URL of its own can't be that target.
 *
 * The `?google=` / `?reason=` query is set by the API's callback redirect.
 */

const CALLBACK_MESSAGE: Record<string, string> = {
  denied: 'ยกเลิกการเชื่อมต่อที่หน้า Google น้า',
  no_code: 'Google ไม่ได้ส่งรหัสยืนยันกลับมา ลองใหม่อีกทีน้า',
  state_mismatch: 'ลิงก์ยืนยันหมดอายุหรือไม่ตรงกัน กดเชื่อมต่อใหม่อีกทีน้า',
  exchange_failed: 'แลกรหัสกับ Google ไม่สำเร็จ ลองใหม่อีกทีน้า',
  bad_request: 'คำขอไม่ถูกต้อง ลองใหม่อีกทีน้า',
};

/** What connecting Sheets actually gives you — the upgrade card's checklist. */
const SHEETS_PERKS = [
  'ซิงค์งานทั้งหมดไป Google Sheet อัตโนมัติ',
  'อัปเดตสถานะงานแบบ real-time',
  'แชร์ข้อมูลทีมผ่าน Google Drive ได้ทันที',
];

function formatWhen(iso: string): string {
  const then = new Date(iso).getTime();
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return 'เมื่อสักครู่';
  if (mins < 60) return `${mins} นาทีที่แล้ว`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ชั่วโมงที่แล้ว`;
  return `${Math.floor(hours / 24)} วันที่แล้ว`;
}

function SheetIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 2.75h7.5L19 8.25v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-17.5a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M13.25 3v5.25H18.5M8.5 12.5h7M8.5 16h7M11.5 12v5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export default function SettingsPage() {
  const [status, setStatus] = useState<GoogleIntegrationStatus | null>(null);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [notice, setNotice] = useState<{ msg: string; ok: boolean } | null>(null);
  // §15 — Google Sheets sync is PREMIUM-only (FEATURE_ACCESS.google_sheets in
  // apps/api/src/config/plans.ts: free false, pro false, premium true). This
  // used to gate on `plan !== 'free'`, which showed a Pro user a working
  // connect button that the server then refused. null while loading.
  const [plan, setPlan] = useState<string | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  const load = useCallback(async () => {
    if (!hasSession()) {
      setNeedsLogin(true);
      setLoading(false);
      return;
    }
    try {
      const [res, me] = await Promise.all([getGoogleIntegration(), getMe()]);
      // null = the deployment has no Google OAuth client configured.
      setAvailable(res !== null);
      setStatus(res);
      setPlan(me.plan);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedsLogin(true);
      else setNotice({ msg: 'โหลดสถานะการเชื่อมต่อไม่สำเร็จน้า', ok: false });
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Pull in the tasks that predate the sheet. Also the landing point for the
   * sheet's own "🔄 sync ประวัติงาน" button: a Sheets HYPERLINK can only GET,
   * and the session cookie lives on THIS origin, so the sheet links here with
   * ?sync=historical and the page makes the real POST.
   */
  const syncHistorical = useCallback(async () => {
    setBusy(true);
    try {
      await syncGoogleHistorical();
      setNotice({
        msg: 'กำลังดึงประวัติงานเก่าให้อยู่น้า — สักครู่แล้วเปิด Sheet ดูได้เลย',
        ok: true,
      });
    } catch (err) {
      const conflict = err instanceof ApiError && err.status === 409;
      const throttled = err instanceof ApiError && err.status === 429;
      setNotice({
        msg: conflict
          ? 'ต้องเชื่อมต่อ Google ก่อนน้า'
          : throttled
            ? 'เพิ่งดึงไปเมื่อกี้น้า รออีกสักครู่แล้วค่อยกดใหม่'
            : 'ดึงประวัติงานเก่าไม่สำเร็จน้า ลองใหม่อีกทีนะ',
        ok: false,
      });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    // Read the callback result, then strip it from the URL so a refresh doesn't
    // replay a stale "เชื่อมต่อแล้ว" banner.
    const params = new URLSearchParams(window.location.search);
    const result = params.get('google');
    if (result === 'connected') {
      setNotice({ msg: 'เชื่อมต่อ Google เรียบร้อยแล้วน้า', ok: true });
    } else if (result === 'error') {
      setNotice({
        msg: CALLBACK_MESSAGE[params.get('reason') ?? ''] ?? 'เชื่อมต่อ Google ไม่สำเร็จน้า',
        ok: false,
      });
    }
    // Arriving from the sheet's button. Strip it the same way, so a refresh
    // doesn't queue a second backfill.
    const wantsHistorical = params.get('sync') === 'historical';
    if (result || wantsHistorical) window.history.replaceState({}, '', '/dashboard/settings');
    void load().then(() => {
      // Skipped when the session is gone — the page is showing the login
      // prompt at that point, and a 401 notice underneath it would just be
      // noise. Pressing the button after logging in works normally.
      if (wantsHistorical && hasSession()) void syncHistorical();
    });
  }, [load, syncHistorical]);

  const connect = async () => {
    // Locked tiers never start the OAuth trip: they get the upgrade card here.
    // The server gate (planGuard) is still the real boundary — see the catch.
    if (locked) {
      setUpgradeOpen(true);
      return;
    }
    setBusy(true);
    try {
      await startGoogleConnect(); // navigates away
    } catch (err) {
      // §15 — Google Sheets is Premium-only, so /integrations/google/auth
      // answers 403 PLAN_UPGRADE_REQUIRED. That is not a connection failure and
      // must not be reported as one: retrying will never work on this plan. The
      // card says so; an inline red line would not.
      if (err instanceof ApiError && err.code === 'PLAN_UPGRADE_REQUIRED') {
        setUpgradeOpen(true);
      } else {
        setNotice({ msg: 'เปิดหน้ายืนยันของ Google ไม่สำเร็จน้า', ok: false });
      }
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm('ยกเลิกการเชื่อมต่อ Google ใช่ไหมน้า? Sheet เดิมยังอยู่ครบ แค่หนูจะหยุดอัปเดตให้')) {
      return;
    }
    setBusy(true);
    try {
      await disconnectGoogle();
      setStatus({ connected: false });
      setNotice({ msg: 'ยกเลิกการเชื่อมต่อแล้วน้า', ok: true });
    } catch {
      setNotice({ msg: 'ยกเลิกการเชื่อมต่อไม่สำเร็จน้า', ok: false });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Is Sheets behind the plan gate for this viewer? Mirrors
   * FEATURE_ACCESS.google_sheets — expressed as "everything below premium is
   * locked", with legacy 'team' rows normalised the way config/plans.ts does.
   * null = plan not loaded yet (avoids flashing the wrong state); it reads as
   * unlocked so a paying user is never blocked by a slow profile fetch.
   */
  const locked = plan === null ? false : plan !== 'premium' && plan !== 'team';
  const showLocked = plan !== null && locked;

  if (needsLogin) {
    return (
      <div className="center-page">
        <Image src="/logo.png" alt="หนูเก็บ" width={120} height={120} className="login-logo" priority />
        <p>เข้าสู่ระบบก่อนน้า</p>
        <button className="btn" onClick={startLineLogin}>
          เข้าสู่ระบบด้วย LINE
        </button>
      </div>
    );
  }

  return (
    <main className="container settings-container">
      <header className="settings-header">
        <a className="settings-back" href="/dashboard">
          ← กลับไปที่ล็อคเกอร์
        </a>
        <h1 className="settings-title">การเชื่อมต่อ</h1>
        <p className="settings-hint">ต่อหนูเก็บเข้ากับบริการอื่นที่พี่ใช้อยู่</p>
      </header>

      {notice && (
        <p className={`settings-notice ${notice.ok ? 'ok' : 'bad'}`} role="status">
          {notice.msg}
        </p>
      )}

      <section className="settings-card">
        <div className="settings-card-head">
          <span className="settings-card-icon">
            <SheetIcon />
          </span>
          <div>
            <h2 className="settings-card-title">
              Google Sheets
              {showLocked && (
                <span className="settings-pro-badge">{PLAN_DISPLAY_NAME.premium}</span>
              )}
            </h2>
            <p className="settings-card-sub">
              ทุกครั้งที่สร้างหรืออัปเดตงาน หนูจะ sync ลง Sheet ของพี่เองให้อัตโนมัติ
            </p>
          </div>
        </div>

        {loading ? (
          <p className="settings-card-state">กำลังโหลด...</p>
        ) : !available ? (
          <p className="settings-card-state">ยังไม่เปิดให้ใช้งานบนระบบนี้น้า</p>
        ) : status?.connected ? (
          <>
            <p className="settings-card-state connected">
              เชื่อมต่อแล้ว{status.email ? ` — ${status.email}` : ''}
            </p>
            {status.lastError ? (
              <p className="settings-card-state bad">{status.lastError}</p>
            ) : status.lastSyncedAt ? (
              <p className="settings-card-state">sync ล่าสุด {formatWhen(status.lastSyncedAt)}</p>
            ) : (
              <p className="settings-card-state">
                Sheet จะถูกสร้างให้อัตโนมัติตอนพี่สร้างหรือแก้งานครั้งถัดไปน้า
              </p>
            )}
            <div className="settings-card-actions">
              {status.sheetUrl && (
                <a className="btn secondary small" href={status.sheetUrl} target="_blank" rel="noreferrer">
                  เปิด Sheet ↗
                </a>
              )}
              <button
                className="btn secondary small"
                onClick={() => void syncHistorical()}
                disabled={busy}
              >
                🔄 sync ประวัติงาน
              </button>
              <button className="btn ghost small" onClick={() => void disconnect()} disabled={busy}>
                ยกเลิกการเชื่อมต่อ
              </button>
            </div>
            <p className="settings-card-note">
              ดึงงานที่สร้างไว้ก่อนเชื่อมต่อเข้ามาทีเดียว งานที่อยู่ใน Sheet แล้วหนูจะไม่เพิ่มซ้ำน้า
            </p>
          </>
        ) : (
          <>
            {/* The card stays fully visible on a locked plan — the feature has
                to be discoverable — but the button explains the gate instead of
                starting an OAuth trip the server will refuse. */}
            <p className="settings-card-state">
              {showLocked
                ? `ต่อ Sheet อัตโนมัติอยู่ในแพลน ${PLAN_DISPLAY_NAME.premium} น้า`
                : 'ยังไม่ได้เชื่อมต่อ'}
            </p>
            <div className="settings-card-actions">
              <button className="btn small" onClick={() => void connect()} disabled={busy}>
                {showLocked
                  ? 'ดูรายละเอียดแพลน →'
                  : busy
                    ? 'กำลังเปิด Google...'
                    : 'เชื่อมต่อ Google Account →'}
              </button>
            </div>
            <p className="settings-card-note">
              หนูขอสิทธิ์แค่ Sheet ที่หนูสร้างเองเท่านั้น (drive.file) — ไฟล์อื่นใน Google Drive
              ของพี่ หนูมองไม่เห็นน้า
            </p>
          </>
        )}
      </section>

      {/* §15 plan gate. Not ProLockModal any more: that one is a fake door, and
          Sheets sync is built and purchasable — so the CTA is a real link. */}
      <UpgradeModal
        open={upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        badgeText={`ต้องใช้แพลน ${PLAN_DISPLAY_NAME.premium} ขึ้นไป`}
        title="Google Sheets Sync ต้องการแพลน Premium น้า"
        subtitle="ซิงค์งานทุกชิ้นไปยัง Google Sheet แบบอัตโนมัติ — อัปเกรดแล้วเชื่อมได้เลย"
        features={SHEETS_PERKS}
      />
    </main>
  );
}
