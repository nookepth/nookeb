'use client';

import { useEffect } from 'react';

/**
 * Scoped error boundary for the admin dashboard — a data-heavy page that pulls
 * many analytics RPCs. Keeps an admin render failure from bubbling to the
 * app-root boundary. Only the digest is logged; no raw message is shown.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Admin error boundary caught an error', { digest: error.digest });
  }, [error]);

  return (
    <div className="center-page">
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
