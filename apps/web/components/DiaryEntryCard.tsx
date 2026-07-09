'use client';

import { useEffect, useState } from 'react';
import type { DiaryStreakResponse } from '@nookeb/shared';
import { getDiaryStreak, hasSession } from '@/lib/api';

/**
 * Dashboard entry card for ไดอารี่ 365 วัน — a tappable card that navigates to
 * /dashboard/diary. Fetches GET /diary/streak once to show a subtitle hint
 * (current streak + total entries). The response is cached module-wide for 60s
 * so re-mounts (tab switches, filter changes) don't refetch. Best-effort: if the
 * fetch fails the card still renders with just the label.
 */

const CACHE_TTL_MS = 60_000;
let cache: { at: number; data: DiaryStreakResponse } | null = null;

async function fetchStreakCached(): Promise<DiaryStreakResponse> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  const data = await getDiaryStreak();
  cache = { at: Date.now(), data };
  return data;
}

export function DiaryEntryCard() {
  const [streak, setStreak] = useState<DiaryStreakResponse | null>(null);

  useEffect(() => {
    if (!hasSession()) return;
    fetchStreakCached()
      .then(setStreak)
      .catch(() => {}); // hint is best-effort — never break the dashboard
  }, []);

  return (
    <a className="diary-banner diary-entry-card" href="/dashboard/diary">
      <span className="diary-banner-emoji" aria-hidden>
        📔
      </span>
      <div className="diary-banner-text">
        <strong>ไดอารี่ของฉัน</strong>
        {streak ? (
          <span>
            🔥 ต่อเนื่อง {streak.currentStreak} วัน · {streak.totalEntries}/365 วัน
          </span>
        ) : (
          <span>บันทึกความทรงจำวันละรูป 🌸</span>
        )}
      </div>
      <span className="diary-banner-btn" aria-hidden>
        เปิด →
      </span>
    </a>
  );
}
