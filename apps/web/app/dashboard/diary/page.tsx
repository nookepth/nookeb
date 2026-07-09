'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import type { DiaryEntryDto, DiaryStreakResponse, DiaryTodayStatusResponse } from '@nookeb/shared';
import {
  ApiError,
  getDiaryStreak,
  getDiaryTodayStatus,
  hasSession,
  listDiaryEntries,
  updateDiaryNotification,
} from '@/lib/api';
import { startLineLogin } from '@/lib/auth';
import { DiaryReminderBanner } from '@/components/DiaryReminderBanner';

/** Today's calendar date in Asia/Bangkok as 'YYYY-MM-DD' ('en-CA' = ISO order). */
function bangkokToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
}

function thaiDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

const THAI_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

interface GridCell {
  date: string; // 'YYYY-MM-DD'
  entry: DiaryEntryDto | null;
}

/** Every day of `year` in order, GitHub-contribution style (columns = weeks). */
function buildYearCells(year: number, entriesByDate: Map<string, DiaryEntryDto>): GridCell[] {
  const cells: GridCell[] = [];
  const d = new Date(Date.UTC(year, 0, 1));
  while (d.getUTCFullYear() === year) {
    const date = d.toISOString().slice(0, 10);
    cells.push({ date, entry: entriesByDate.get(date) ?? null });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return cells;
}

export default function DiaryDashboardPage() {
  const router = useRouter();
  const [needsLogin, setNeedsLogin] = useState(false);
  const [year, setYear] = useState(() => Number(bangkokToday().slice(0, 4)));
  const [entries, setEntries] = useState<DiaryEntryDto[] | null>(null);
  const [streak, setStreak] = useState<DiaryStreakResponse | null>(null);
  const [status, setStatus] = useState<DiaryTodayStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // notification settings form
  const [notifyEnabled, setNotifyEnabled] = useState(true);
  const [notifyTime, setNotifyTime] = useState('20:00');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // grid hover preview (desktop)
  const [preview, setPreview] = useState<{ entry: DiaryEntryDto; x: number; y: number } | null>(null);

  const today = bangkokToday();

  const load = useCallback(async () => {
    if (!hasSession()) {
      setNeedsLogin(true);
      return;
    }
    try {
      const [entriesRes, streakRes, statusRes] = await Promise.all([
        listDiaryEntries(year),
        getDiaryStreak(),
        getDiaryTodayStatus(),
      ]);
      setEntries(entriesRes.entries);
      setStreak(streakRes);
      setStatus(statusRes);
      setNotifyEnabled(statusRes.notification.isEnabled);
      setNotifyTime(statusRes.notification.notifyTime);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedsLogin(true);
      else setError('โหลดไดอารี่ไม่สำเร็จ ลองรีเฟรชอีกครั้งน้า');
    }
  }, [year]);

  useEffect(() => {
    void load();
  }, [load]);

  const entriesByDate = useMemo(() => {
    const map = new Map<string, DiaryEntryDto>();
    for (const e of entries ?? []) map.set(e.entryDate, e);
    return map;
  }, [entries]);

  const cells = useMemo(() => buildYearCells(year, entriesByDate), [year, entriesByDate]);

  // Leading blanks align Jan 1 to its weekday row (grid flows column-first).
  const leadingBlanks = useMemo(() => new Date(Date.UTC(year, 0, 1)).getUTCDay(), [year]);

  // Month labels positioned at the week-column where each month starts.
  const monthLabels = useMemo(() => {
    return THAI_MONTHS_SHORT.map((label, m) => {
      const firstIndex = leadingBlanks + Math.floor((Date.UTC(year, m, 1) - Date.UTC(year, 0, 1)) / 86400000);
      return { label, column: Math.floor(firstIndex / 7) + 1 };
    });
  }, [year, leadingBlanks]);

  const recent = useMemo(() => (entries ?? []).slice(-7).reverse(), [entries]);

  async function saveNotification(): Promise<void> {
    setSaveState('saving');
    try {
      await updateDiaryNotification({
        notifyTime,
        isEnabled: notifyEnabled,
        timezone: status?.notification.timezone ?? 'Asia/Bangkok',
      });
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2000);
    } catch {
      setSaveState('error');
    }
  }

  if (needsLogin) {
    return (
      <div className="center-page">
        <Image src="/logo.png" alt="หนูเก็บ" width={120} height={120} className="login-logo" priority />
        <h1>หนูเก็บ</h1>
        <p>เข้าสู่ระบบด้วย LINE เพื่อเปิดไดอารี่ของคุณ</p>
        <button className="btn" onClick={startLineLogin}>
          เข้าสู่ระบบด้วย LINE
        </button>
      </div>
    );
  }

  return (
    <main className="container diary-container">
      <header className="diary-header">
        <a className="diary-back" href="/dashboard">
          ← กลับคลัง
        </a>
        <h1 className="diary-title">📔 ไดอารี่ของฉัน</h1>
        {streak && (
          <p className="diary-stats">
            <span className="diary-streak">🔥 {streak.currentStreak} วันติดต่อกัน</span>
            <span className="diary-stats-sep">|</span>
            <span>
              รวม {streak.totalEntries}/365 วัน
            </span>
          </p>
        )}
      </header>

      <DiaryReminderBanner />

      {error && <div className="diary-error">{error}</div>}

      {/* วิธีบันทึก — entries are created in the LINE chat */}
      {status && !status.submitted && (
        <div className="diary-howto">
          วันนี้ยังไม่ได้บันทึกเลยน้า — เปิดแชท LINE หนูเก็บ พิมพ์ <strong>&quot;ไดอารี่&quot;</strong> แล้วส่งรูป 1 รูปได้เลย 🌸
        </div>
      )}
      {status?.submitted && <div className="diary-done-chip">วันนี้บันทึกแล้ว ✓</div>}

      {/* ---------- 365-day grid ---------- */}
      <section className="diary-grid-card">
        <div className="diary-grid-toolbar">
          <button
            className="diary-year-btn"
            onClick={() => setYear((y) => y - 1)}
            disabled={year <= 2020}
            aria-label="ปีก่อนหน้า"
          >
            ‹
          </button>
          <span className="diary-year">{year + 543}</span>
          <button
            className="diary-year-btn"
            onClick={() => setYear((y) => y + 1)}
            disabled={year >= Number(today.slice(0, 4))}
            aria-label="ปีถัดไป"
          >
            ›
          </button>
        </div>
        <div className="diary-grid-scroll">
          <div className="diary-month-row">
            {monthLabels.map((m) => (
              <span key={m.label} style={{ gridColumnStart: m.column }}>
                {m.label}
              </span>
            ))}
          </div>
          <div className="diary-grid" role="grid" aria-label={`ไดอารี่ปี ${year + 543}`}>
            {Array.from({ length: leadingBlanks }).map((_, i) => (
              <span key={`blank-${i}`} className="diary-cell blank" />
            ))}
            {cells.map((cell) => {
              const isToday = cell.date === today;
              const isFuture = cell.date > today;
              const cls = [
                'diary-cell',
                cell.entry ? 'filled' : 'empty',
                isToday ? 'today' : '',
                isFuture ? 'future' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <button
                  key={cell.date}
                  className={cls}
                  title={cell.entry ? `${thaiDate(cell.date)} — ${cell.entry.caption || 'ไม่มีข้อความ'}` : thaiDate(cell.date)}
                  onClick={() => cell.entry && router.push(`/dashboard/diary/${cell.date}`)}
                  onMouseEnter={(e) =>
                    cell.entry && setPreview({ entry: cell.entry, x: e.clientX, y: e.clientY })
                  }
                  onMouseLeave={() => setPreview(null)}
                  disabled={!cell.entry}
                  aria-label={cell.entry ? `เปิดไดอารี่ ${thaiDate(cell.date)}` : thaiDate(cell.date)}
                />
              );
            })}
          </div>
        </div>
        <div className="diary-grid-legend">
          <span className="diary-cell empty" /> ยังไม่บันทึก
          <span className="diary-cell filled" /> บันทึกแล้ว
          <span className="diary-cell today" /> วันนี้
        </div>
      </section>

      {/* hover thumbnail preview */}
      {preview && (
        <div
          className="diary-hover-preview"
          style={{
            left: Math.min(preview.x + 12, typeof window !== 'undefined' ? window.innerWidth - 190 : 0),
            top: preview.y + 14,
          }}
        >
          {preview.entry.thumbnailUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- presigned R2 URL, not a static asset
            <img src={preview.entry.thumbnailUrl} alt="" />
          )}
          <span className="diary-hover-date">{thaiDate(preview.entry.entryDate)}</span>
          {preview.entry.caption && <span className="diary-hover-caption">{preview.entry.caption}</span>}
        </div>
      )}

      {/* ---------- recent entries ---------- */}
      {recent.length > 0 && (
        <section className="diary-recent">
          <h2>บันทึกล่าสุด</h2>
          <div className="diary-recent-strip">
            {recent.map((e) => (
              <a key={e.id} className="diary-polaroid-card" href={`/dashboard/diary/${e.entryDate}`}>
                {e.thumbnailUrl && (
                  // eslint-disable-next-line @next/next/no-img-element -- presigned R2 URL
                  <img src={e.thumbnailUrl} alt="" loading="lazy" />
                )}
                <span className="diary-polaroid-date">{thaiDate(e.entryDate)}</span>
                {e.caption && <span className="diary-polaroid-caption">{e.caption}</span>}
              </a>
            ))}
          </div>
        </section>
      )}
      {entries !== null && entries.length === 0 && (
        <p className="diary-empty">ยังไม่มีบันทึกในปีนี้เลยน้า เริ่มวันแรกได้เลย 🌸</p>
      )}

      {/* ---------- notification settings ---------- */}
      <section className="diary-settings">
        <h2>แจ้งเตือนบันทึกไดอารี่</h2>
        <p className="diary-settings-hint">
          ถ้ายังไม่ได้บันทึก เราจะแสดงแถบเตือนบนหน้าเว็บหลังเวลาที่เลือกไว้
        </p>
        <div className="diary-settings-row">
          <label className="diary-toggle">
            <input
              type="checkbox"
              checked={notifyEnabled}
              onChange={(e) => setNotifyEnabled(e.target.checked)}
            />
            <span>เปิดแจ้งเตือน</span>
          </label>
          <label className="diary-time">
            เวลา
            <input type="time" value={notifyTime} onChange={(e) => setNotifyTime(e.target.value)} />
          </label>
          <button className="btn diary-save-btn" onClick={saveNotification} disabled={saveState === 'saving'}>
            {saveState === 'saving' ? 'กำลังบันทึก…' : saveState === 'saved' ? 'บันทึกแล้ว ✓' : 'บันทึก'}
          </button>
        </div>
        {saveState === 'error' && <p className="diary-error">บันทึกการตั้งค่าไม่สำเร็จ ลองใหม่อีกทีน้า</p>}
      </section>
    </main>
  );
}
