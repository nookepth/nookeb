'use client';

import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Itim, Caveat } from 'next/font/google';
import {
  ApiError,
  deleteDiaryEntry,
  getDiaryEntry,
  hasSession,
  type DiaryEntryDetail,
} from '@/lib/api';
import { startLineLogin } from '@/lib/auth';

// Handwriting fonts for the "classic_pink" scrapbook template: Itim renders
// Thai captions in a hand-drawn style; Caveat covers the latin "Day X / 365"
// flourish. Loaded via next/font so nothing external is fetched at runtime.
const itim = Itim({ weight: '400', subsets: ['thai', 'latin'], display: 'swap' });
const caveat = Caveat({ weight: '600', subsets: ['latin'], display: 'swap' });

function thaiDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString('th-TH', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** Inline SVG decorations — no external image assets (Section 6 rule). */
function Decorations() {
  return (
    <div className="diary-decor" aria-hidden>
      <svg viewBox="0 0 24 24" className="decor decor-heart">
        <path
          d="M12 21s-7.5-4.9-10-9.2C.4 8.6 1.7 5 5 4.3c2-.4 3.9.5 5 2.1 1.1-1.6 3-2.5 5-2.1 3.3.7 4.6 4.3 3 7.5C19.5 16.1 12 21 12 21z"
          fill="#F3A8C4"
        />
      </svg>
      <svg viewBox="0 0 24 24" className="decor decor-star">
        <path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z" fill="#F6C453" />
      </svg>
      <svg viewBox="0 0 24 24" className="decor decor-flower">
        <g fill="#8FD0C6">
          <circle cx="12" cy="6" r="3.4" />
          <circle cx="18" cy="12" r="3.4" />
          <circle cx="12" cy="18" r="3.4" />
          <circle cx="6" cy="12" r="3.4" />
        </g>
        <circle cx="12" cy="12" r="2.6" fill="#F6C453" />
      </svg>
    </div>
  );
}

export default function DiaryEntryPage({ params }: { params: { date: string } }) {
  const router = useRouter();
  const [date, setDate] = useState(params.date);
  const [entry, setEntry] = useState<DiaryEntryDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'notfound' | 'login'>('loading');
  // 'left' = went to a newer page, 'right' = older — drives the slide transition
  const [slideFrom, setSlideFrom] = useState<'left' | 'right' | null>(null);

  const load = useCallback(async (d: string) => {
    if (!hasSession()) {
      setState('login');
      return;
    }
    try {
      const detail = await getDiaryEntry(d);
      setEntry(detail);
      setState('ready');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setState('login');
      else setState('notfound');
    }
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  // Page-flip: client-side date swap + history.replaceState keeps the slide
  // transition alive (a router.push would remount the whole page), while the
  // URL stays shareable.
  const navigate = useCallback(
    (nextDate: string | null, direction: 'left' | 'right') => {
      if (!nextDate) return;
      setSlideFrom(direction);
      setDate(nextDate);
      window.history.replaceState(null, '', `/dashboard/diary/${nextDate}`);
    },
    [],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!entry) return;
      if (e.key === 'ArrowLeft') navigate(entry.prevDate, 'right');
      if (e.key === 'ArrowRight') navigate(entry.nextDate, 'left');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entry, navigate]);

  async function handleDelete(): Promise<void> {
    if (!entry) return;
    if (!window.confirm(`ลบบันทึกวันที่ ${thaiDate(entry.entryDate)} ?`)) return;
    try {
      await deleteDiaryEntry(entry.id);
      router.push('/dashboard/diary');
    } catch {
      alert('ลบไม่สำเร็จ ลองใหม่อีกทีน้า');
    }
  }

  if (state === 'login') {
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

  if (state === 'notfound') {
    return (
      <div className="center-page">
        <p>ไม่พบบันทึกของวันนี้เลยน้า</p>
        <a className="btn" href="/dashboard/diary">
          กลับไปหน้าไดอารี่
        </a>
      </div>
    );
  }

  return (
    <main className="diary-viewer">
      <div className="diary-viewer-top">
        <a className="diary-back" href="/dashboard/diary">
          ← ไดอารี่ของฉัน
        </a>
        {entry && <span className="diary-viewer-date">{thaiDate(entry.entryDate)}</span>}
        {entry && (
          <button className="diary-delete-btn" onClick={handleDelete}>
            ลบ
          </button>
        )}
      </div>

      <div className="diary-book">
        {state === 'loading' && <div className="diary-sheet diary-sheet-loading">กำลังเปิดสมุด…</div>}
        {state === 'ready' && entry && (
          <article
            key={entry.entryDate}
            className={`diary-sheet template-classic-pink ${
              slideFrom === 'left' ? 'slide-from-right' : slideFrom === 'right' ? 'slide-from-left' : 'sheet-appear'
            }`}
          >
            {/* spiral binding, rendered in CSS-only circles */}
            <div className="diary-spiral" aria-hidden>
              {Array.from({ length: 10 }).map((_, i) => (
                <span key={i} />
              ))}
            </div>

            <div className="diary-sheet-inner">
              <div className="diary-sheet-top">
                <span className={`diary-date-stamp ${itim.className}`}>{thaiDate(entry.entryDate)}</span>
                <span className={`diary-day-counter ${caveat.className}`}>
                  Day {entry.dayNumber ?? '?'} / 365
                </span>
              </div>

              <figure className="diary-photo-polaroid">
                {/* eslint-disable-next-line @next/next/no-img-element -- presigned R2 URL (1h expiry) */}
                <img src={entry.imageUrl} alt={entry.caption || `ไดอารี่ ${entry.entryDate}`} />
              </figure>

              <div className={`diary-caption-note ${itim.className}`}>
                {entry.caption || 'วันนี้ไม่มีข้อความ มีแต่ความทรงจำ ✿'}
              </div>

              <Decorations />
            </div>
          </article>
        )}

        {/* page-flip navigation */}
        {entry && (
          <div className="diary-flip-nav">
            <button
              className="diary-flip-btn"
              onClick={() => navigate(entry.prevDate, 'right')}
              disabled={!entry.prevDate}
              aria-label="หน้าก่อนหน้า"
            >
              ← ก่อนหน้า
            </button>
            <button
              className="diary-flip-btn"
              onClick={() => navigate(entry.nextDate, 'left')}
              disabled={!entry.nextDate}
              aria-label="หน้าถัดไป"
            >
              ถัดไป →
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
