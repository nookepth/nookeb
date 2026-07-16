'use client';

import { formatBytes } from '@/lib/format';
import type { VaultStats, VaultStatus } from '@/lib/api';

/**
 * Dashboard entry card for ห้องนิรภัย — a tappable card that navigates to
 * /dashboard/vault. Presentational: the dashboard owns the fetch (see
 * useVaultSummary) because the stat chip in the stats-row needs the same data.
 *
 * Privacy: the breakdown renders ONLY when the vault is currently unlocked. A
 * locked vault shows a lock hint and no counts — matching the API, where
 * GET /vault/stats is behind the same unlock guard as every other vault read.
 * The card hides entirely when no PIN is set (nothing to advertise; /vault is
 * reachable from the nav for setup).
 */

export function VaultEntryCard({
  status,
  stats,
}: {
  status: VaultStatus | null;
  stats: VaultStats | null;
}) {
  if (!status?.hasPin) return null;

  const unlocked = status.isUnlocked && stats !== null;

  return (
    <a className="diary-banner vault-entry-card" href="/dashboard/vault">
      <span className="diary-banner-emoji" aria-hidden>
        {unlocked ? '🔓' : '🔐'}
      </span>
      <div className="diary-banner-text">
        <strong>ห้องนิรภัย</strong>
        {unlocked ? (
          <span>
            {stats.fileCount} ไฟล์
            {stats.imageCount > 0 && ` · รูป ${stats.imageCount}`}
            {stats.videoCount > 0 && ` · วิดีโอ ${stats.videoCount}`}
            {stats.pdfCount > 0 && ` · PDF ${stats.pdfCount}`}
            {' · ใช้พื้นที่ '}
            {formatBytes(stats.storageUsed)}
          </span>
        ) : (
          <span>🔒 ล็อคอยู่ · แตะเพื่อปลดล็อค</span>
        )}
      </div>
      <span className="diary-banner-btn" aria-hidden>
        เปิดตู้ →
      </span>
    </a>
  );
}
