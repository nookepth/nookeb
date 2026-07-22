'use client';

import { useEffect } from 'react';
import Image from 'next/image';

/**
 * Catches render/runtime errors thrown anywhere in the app subtree (below the
 * root layout). Root-layout errors are handled by global-error.tsx instead.
 * The raw error message is never shown to the user — only the digest is logged
 * to the console for support triage.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log only the digest (stable id Next.js attaches) — never the raw message.
    console.error('App error boundary caught an error', { digest: error.digest });
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
