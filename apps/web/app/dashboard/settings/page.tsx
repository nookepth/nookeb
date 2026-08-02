'use client';

import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import type { SheetsTrialStatus } from '@nookeb/shared';
import {
  ApiError,
  disconnectGoogle,
  getGoogleIntegration,
  getSheetsTrial,
  hasSession,
  startGoogleConnect,
  syncGoogleHistorical,
  type GoogleIntegrationStatus,
} from '@/lib/api';
import { startLineLogin } from '@/lib/auth';
import { PLAN_DISPLAY_NAME } from '@/lib/quota-errors';
import { UpgradeModal } from '@/components/UpgradeModal';
import { ConnectSheet } from '@/components/SheetsTrial/ConnectSheet';
import { SHEETS_PERKS } from '@/components/SheetsTrial/perks';
import { TrialBanner } from '@/components/SheetsTrial/TrialBanner';

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
  // The API's post-redirect entitlement re-check refused. `trial_expired` is
  // the narrow but real case of finishing the Google consent screen after the
  // trial ran out mid-flow — worth its own sentence, because "ลองใหม่" is
  // exactly the wrong advice there.
  plan_required: 'ยังไม่มีสิทธิ์เชื่อม Google Sheets น้า',
  trial_expired: 'หนูเก็บลองงานหมดอายุระหว่างเชื่อมต่อพอดีน้า เลยยังต่อให้ไม่ได้',
};

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
  /**
   * §15 + migration 062 — entitlement is now "premium plan OR live
   * หนูเก็บลองงาน trial", and the SERVER computes it. This used to read
   * `me.plan` and compare it to 'premium' in the browser; that cannot see a
   * trial, and duplicating the rule here is how the client's idea of who may
   * connect drifts from the server's. `access.allowed` is the same value
   * sheetsTrialGuard enforces. null while loading.
   */
  const [trial, setTrial] = useState<SheetsTrialStatus | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  const load = useCallback(async () => {
    if (!hasSession()) {
      setNeedsLogin(true);
      setLoading(false);
      return;
    }
    try {
      const [res, trialRes] = await Promise.all([getGoogleIntegration(), getSheetsTrial()]);
      // null = the deployment has no Google OAuth client configured.
      setAvailable(res !== null);
      setStatus(res);
      setTrial(trialRes);
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
    // Unentitled viewers never start the OAuth trip: they get the upgrade card
    // here. The server gate (sheetsTrialGuard) is still the real boundary —
    // see the catch.
    if (!entitled) {
      setUpgradeOpen(true);
      return;
    }
    setBusy(true);
    try {
      await startGoogleConnect(); // navigates away
    } catch (err) {
      // §15 + 062 — /integrations/google/auth answers 403 with either
      // PLAN_UPGRADE_REQUIRED (no trial in play) or SHEETS_TRIAL_EXPIRED.
      // Neither is a connection failure and neither must be reported as one:
      // retrying will never work. The card says so; an inline red line would
      // not. Reached when entitlement lapsed between page load and the click.
      if (
        err instanceof ApiError &&
        (err.code === 'PLAN_UPGRADE_REQUIRED' || err.code === 'SHEETS_TRIAL_EXPIRED')
      ) {
        setUpgradeOpen(true);
        void load(); // resync — the banner is showing stale state
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
   * May this viewer connect? Straight from the server (`access.allowed` =
   * premium plan OR live trial) rather than re-derived from `users.plan` here,
   * which is what let the pre-062 version of this page miss the trial entirely.
   *
   * While the trial status is still loading it reads as ENTITLED, so a paying
   * user is never shown a lock by a slow fetch; the real gate is the request.
   */
  const entitled = trial === null ? true : trial.access.allowed;
  /** Show the premium badge only for viewers who have neither plan nor trial. */
  const showLocked = trial !== null && !trial.access.allowed;

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
              {/* A user who still holds an unclaimed trial must not be met by a
                  premium padlock badge — it is the correct badge for someone
                  with nothing left to claim, and exactly the wrong one for
                  someone being offered the feature for free. Same pill, the
                  headline fact swapped. */}
              {trial?.canActivate ? (
                <span className="settings-pro-badge">ทดลองฟรี {trial.trialDays} วัน</span>
              ) : showLocked ? (
                <span className="settings-pro-badge">{PLAN_DISPLAY_NAME.premium}</span>
              ) : null}
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
        ) : (
          <>
            {/* หนูเก็บลองงาน (migration 062). Renders nothing for a viewer
                entitled by PLAN — a permanent subscriber has no countdown to
                read — and nothing once the one-shot is spent and expired copy
                would just repeat the block below. */}
            {trial && (
              <TrialBanner
                status={trial}
                connected={status?.connected ?? false}
                onActivated={() => void load()}
                onUpgrade={() => setUpgradeOpen(true)}
                disabled={busy}
              />
            )}

            <ConnectSheet
              status={status ?? { connected: false }}
              entitled={entitled}
              // An unstarted trial is a next step, not a wall — the locked copy
              // has to say which one this is. See ConnectSheet's header.
              lockReason={trial?.canActivate ? 'trial-available' : 'upgrade'}
              busy={busy}
              onConnect={() => void connect()}
              onDisconnect={() => void disconnect()}
              onSyncHistorical={() => void syncHistorical()}
            />

            {/* The card stays fully visible without entitlement — the feature
                has to stay discoverable — and this is the upgrade path for a
                viewer the trial panel gives none: no trial left to start, and
                none that ran out. An EXPIRED trial is excluded because its own
                panel already carries an upgrade button opening this same modal,
                and two CTAs for one action read as two different offers. */}
            {showLocked && !trial?.canActivate && !trial?.trial.isExpired && (
              <div className="settings-card-actions">
                <button className="btn small" onClick={() => setUpgradeOpen(true)} disabled={busy}>
                  ดูรายละเอียดแพลน →
                </button>
              </div>
            )}
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
