'use client';

import { useEffect } from 'react';
import Image from 'next/image';

/**
 * Scoped error boundary for the dashboard subtree (file browsing, uploads,
 * teams, tasks — the app's mutation-heavy core). Keeps a dashboard render
 * failure from bubbling to the app-root boundary. Only the digest is logged.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Dashboard error boundary caught an error', { digest: error.digest });
  }, [error]);

  return (
    <div className="center-page">
      <Image
        src="/logo.png"
        alt="หนูเก็บ"
        width={96}
        height={96}
        className="login-logo"
        priority
      />
      <h1>เกิดข้อผิดพลาด</h1>
      <p className="error-desc">บางอย่างผิดพลาด กรุณาลองใหม่อีกครั้ง</p>
      <div className="error-actions">
        <button className="btn" type="button" onClick={() => reset()}>
          ลองใหม่
        </button>
        <a className="btn secondary" href="/dashboard">
          กลับหน้าหลัก
        </a>
      </div>
    </div>
  );
}
