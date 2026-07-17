'use client';

import { useEffect, useState } from 'react';
import type { LegacyBoxListResponse } from '@nookeb/shared';
import { THEMES } from '@nookeb/shared';
import { hasSession, listLegacyBoxes } from '@/lib/api';

/**
 * Dashboard entry card for กล่องของขวัญ — reuses .diary-banner's geometry
 * (same card shape as the diary/vault cards) but bleeds the warm gradient of
 * the user's most recent box theme. Fetches GET /legacy-box once, cached
 * module-wide for 60s (same pattern as DiaryEntryCard). Best-effort: if the
 * fetch fails the card still renders with just the label.
 */

const CACHE_TTL_MS = 60_000;
let cache: { at: number; data: LegacyBoxListResponse } | null = null;

async function fetchBoxesCached(): Promise<LegacyBoxListResponse> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  const data = await listLegacyBoxes();
  cache = { at: Date.now(), data };
  return data;
}

export function LegacyBoxEntryCard() {
  const [summary, setSummary] = useState<LegacyBoxListResponse | null>(null);

  useEffect(() => {
    if (!hasSession()) return;
    fetchBoxesCached()
      .then(setSummary)
      .catch(() => {}); // hint is best-effort — never break the dashboard
  }, []);

  const theme = THEMES[summary?.boxes[0]?.theme ?? 'rose'];

  return (
    <a
      className="diary-banner diary-entry-card"
      href="/dashboard/legacy-box"
      style={{
        background: theme.gradient,
        borderColor: theme.ribbon,
      }}
    >
      <span className="diary-banner-emoji" aria-hidden>
        🎁
      </span>
      <div className="diary-banner-text">
        <strong style={{ color: theme.text }}>กล่องของขวัญ</strong>
        {summary && summary.total > 0 ? (
          <span style={{ color: theme.text, opacity: 0.75 }}>
            {summary.total} กล่อง · เปิดแล้ว {summary.totalViews} ครั้ง
          </span>
        ) : (
          <span style={{ color: theme.text, opacity: 0.75 }}>
            สร้างของขวัญดิจิทัลให้คนที่คุณรัก ✨
          </span>
        )}
      </div>
      <span className="diary-banner-btn" aria-hidden style={{ background: theme.accent }}>
        {summary && summary.total > 0 ? 'ดูกล่อง →' : 'สร้างกล่อง →'}
      </span>
    </a>
  );
}
