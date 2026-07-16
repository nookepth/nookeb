'use client';

import { useEffect, useState } from 'react';
import { ApiError, getVaultStats, getVaultStatus, hasSession, type VaultStats, type VaultStatus } from '@/lib/api';

/**
 * Vault summary for the dashboard (stat chip + entry card share one fetch).
 *
 * Two-step by design, so a locked vault leaks nothing:
 *  1. GET /vault/session-status — cheap, needs no unlock session.
 *  2. GET /vault/stats — ONLY when step 1 says isUnlocked. It sits behind the
 *     unlock guard, so calling it while locked would just 403.
 *
 * Best-effort throughout: any failure leaves stats null and the UI falls back to
 * the locked/hidden state rather than breaking the dashboard. A 503 is normal —
 * the vault is dormant until VAULT_MASTER_KEY is set.
 */
export function useVaultSummary(): { status: VaultStatus | null; stats: VaultStats | null } {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [stats, setStats] = useState<VaultStats | null>(null);

  useEffect(() => {
    if (!hasSession()) return;
    let cancelled = false;

    void (async () => {
      let current: VaultStatus;
      try {
        current = await getVaultStatus();
      } catch (err) {
        // Never surface a vault problem as a logout — vaultFetch already clears
        // the session on a genuine codeless 401; anything else is just "no card".
        if (err instanceof ApiError && err.status === 401) return;
        return;
      }
      if (cancelled) return;
      setStatus(current);
      if (!current.isUnlocked) return;

      try {
        const s = await getVaultStats();
        if (!cancelled) setStats(s);
      } catch {
        // Unlock could have lapsed between the two calls — locked state is fine.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { status, stats };
}
