'use client';

import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import {
  ApiError,
  disconnectGoogle,
  getGoogleIntegration,
  hasSession,
  startGoogleConnect,
  type GoogleIntegrationStatus,
} from '@/lib/api';
import { startLineLogin } from '@/lib/auth';

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

  const load = useCallback(async () => {
    if (!hasSession()) {
      setNeedsLogin(true);
      setLoading(false);
      return;
    }
    try {
      const res = await getGoogleIntegration();
      // null = the deployment has no Google OAuth client configured.
      setAvailable(res !== null);
      setStatus(res);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedsLogin(true);
      else setNotice({ msg: 'โหลดสถานะการเชื่อมต่อไม่สำเร็จน้า', ok: false });
    } finally {
      setLoading(false);
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
    if (result) window.history.replaceState({}, '', '/dashboard/settings');
    void load();
  }, [load]);

  const connect = async () => {
    setBusy(true);
    try {
      await startGoogleConnect(); // navigates away
    } catch {
      setNotice({ msg: 'เปิดหน้ายืนยันของ Google ไม่สำเร็จน้า', ok: false });
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
            <h2 className="settings-card-title">Google Sheets</h2>
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
              <button className="btn ghost small" onClick={() => void disconnect()} disabled={busy}>
                ยกเลิกการเชื่อมต่อ
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="settings-card-state">ยังไม่ได้เชื่อมต่อ</p>
            <div className="settings-card-actions">
              <button className="btn small" onClick={() => void connect()} disabled={busy}>
                {busy ? 'กำลังเปิด Google...' : 'เชื่อมต่อ Google Account →'}
              </button>
            </div>
            <p className="settings-card-note">
              หนูขอสิทธิ์แค่ Sheet ที่หนูสร้างเองเท่านั้น (drive.file) — ไฟล์อื่นใน Google Drive
              ของพี่ หนูมองไม่เห็นน้า
            </p>
          </>
        )}
      </section>
    </main>
  );
}
