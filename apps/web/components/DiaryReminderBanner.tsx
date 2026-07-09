'use client';

import { useEffect, useState } from 'react';
import { getDiaryTodayStatus, hasSession } from '@/lib/api';

/**
 * ไดอารี่ reminder — notification "Option C": this project's LINE messaging is
 * reply-only (no pushes, ever), so the daily reminder is an in-app banner. It
 * shows when (a) today has no diary entry, (b) reminders are enabled, and
 * (c) the current time in the user's timezone has passed their notify_time.
 * Self-contained: fetches its own status and renders nothing until it's due.
 */

function isDue(notifyTime: string, timezone: string): boolean {
  try {
    // 'en-GB' 2-digit 24h gives 'HH:mm' — directly comparable to notify_time.
    const now = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
    return now >= notifyTime;
  } catch {
    return false; // unknown timezone string — fail quiet, never crash the page
  }
}

export function DiaryReminderBanner() {
  const [show, setShow] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!hasSession()) return;
    getDiaryTodayStatus()
      .then((s) => {
        if (!s.submitted && s.notification.isEnabled && isDue(s.notification.notifyTime, s.notification.timezone)) {
          setShow(true);
        }
      })
      .catch(() => {}); // banner is best-effort — API hiccups must not break the page
  }, []);

  if (!show || dismissed) return null;
  return (
    <div className="diary-banner" role="status">
      <span className="diary-banner-emoji" aria-hidden>
        📔
      </span>
      <div className="diary-banner-text">
        <strong>อย่าลืมบันทึกไดอารี่วันนี้นะ!</strong>
        <span>วันนี้ยังไม่มีรูปในไดอารี่ของคุณเลย เพิ่มสักรูปได้เลย 🌸</span>
      </div>
      <a className="diary-banner-btn" href="/dashboard/diary">
        บันทึกเลย
      </a>
      <button className="diary-banner-close" onClick={() => setDismissed(true)} aria-label="ปิดแจ้งเตือน">
        ✕
      </button>
    </div>
  );
}
