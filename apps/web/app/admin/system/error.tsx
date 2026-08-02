'use client';

import { useEffect } from 'react';

/**
 * Scoped error boundary for the ops dashboard — mirrors admin/error.tsx.
 *
 * Its own boundary rather than inheriting the parent admin one because this
 * page polls on a 10 s timer: a render failure here would otherwise re-throw on
 * every tick and take the whole /admin subtree down with it. Only the digest is
 * logged; no raw message is shown.
 */
export default function AdminSystemError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Admin system error boundary caught an error', { digest: error.digest });
  }, [error]);

  return (
    <div className="center-page">
      <h1>เกิดข้อผิดพลาด</h1>
      <p className="error-desc">บางอย่างผิดพลาด กรุณาลองใหม่อีกครั้ง</p>
      <div className="error-actions">
        <button className="btn" type="button" onClick={() => reset()}>
          ลองใหม่
        </button>
        <a className="btn secondary" href="/admin">
          กลับแดชบอร์ดผู้ดูแล
        </a>
      </div>
    </div>
  );
}
