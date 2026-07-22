'use client';

import { useEffect } from 'react';

/**
 * Catches errors thrown by the root layout itself. Because it REPLACES the root
 * layout when it renders, it must ship its own <html>/<body> (Next.js
 * requirement) and cannot rely on globals.css being applied — so all styling is
 * inline. Only the error digest is logged; the raw message is never shown.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Global error boundary caught an error', { digest: error.digest });
  }, [error]);

  return (
    <html lang="th">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          padding: 24,
          textAlign: 'center',
          background: '#f8f7f5',
          color: '#1a1a1a',
          fontFamily:
            "'IBM Plex Sans Thai', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        }}
      >
        <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700 }}>เกิดข้อผิดพลาด</h1>
        <p style={{ margin: 0, maxWidth: 340, fontSize: '0.875rem', color: '#6b6b6b', lineHeight: 1.6 }}>
          บางอย่างผิดพลาด กรุณาลองใหม่อีกครั้ง
        </p>
        <button
          type="button"
          onClick={() => reset()}
          style={{
            minHeight: 42,
            padding: '8px 18px',
            borderRadius: 9999,
            border: '1px solid transparent',
            background: '#c0392b',
            color: '#ffffff',
            fontSize: '0.875rem',
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
        >
          รีโหลดหน้า
        </button>
      </body>
    </html>
  );
}
