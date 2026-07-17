'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BOX_SHARE_COPY, shareOrCopy } from '@/lib/share';
import styles from './page.module.css';

/**
 * Success-screen share actions for กล่องของขวัญ. The share/copy behaviour lives
 * in `lib/share.ts` (shared with the box list card) — this component only maps
 * its outcome onto button labels.
 *
 * The LINE row is a plain social-plugins URL — deliberately no LINE SDK.
 *
 * `shareUrl` comes from the API (built from WEB_URL), so it is already an
 * absolute https:// link and is safe to hand to navigator.share / LINE.
 */

const FEEDBACK_MS = 2000;

type ShareState = 'idle' | 'sent' | 'copied';
type CopyState = 'idle' | 'copied' | 'error';

function LineLogo(): JSX.Element {
  return (
    <svg className={styles.lineLogo} viewBox="0 0 24 24" aria-hidden focusable="false">
      <path
        fill="currentColor"
        d="M12 2.5c5.52 0 10 3.53 10 7.88 0 1.74-.68 3.31-2.02 4.83-1.94 2.23-6.28 4.95-7.36 5.4-1.05.45-.92-.24-.87-.55l.14-.86c.04-.25.07-.65-.03-.9-.11-.29-.56-.44-.89-.51-4.87-.64-8.47-4.04-8.47-8.1C2.5 6.03 6.98 2.5 12 2.5Zm-3.2 5.6a.53.53 0 0 0-.53.53v4.24c0 .29.24.53.53.53h.42c.29 0 .52-.24.52-.53V8.63a.53.53 0 0 0-.52-.53h-.42Zm-3.09 0a.53.53 0 0 0-.52.53v4.24c0 .29.23.53.52.53h2.34c.29 0 .53-.24.53-.53v-.42a.53.53 0 0 0-.53-.53H6.24V8.63a.53.53 0 0 0-.53-.53h-.42Zm5.66 0a.53.53 0 0 0-.53.53v4.24c0 .29.24.53.53.53h.42c.29 0 .52-.24.52-.53v-2.1l1.93 2.64c.1.14.26.22.43.22h.42c.29 0 .53-.24.53-.53V8.63a.53.53 0 0 0-.53-.53h-.42a.53.53 0 0 0-.52.53v2.11l-1.94-2.65a.53.53 0 0 0-.42-.22h-.42Zm5.68 0a.53.53 0 0 0-.53.53v4.24c0 .29.24.53.53.53h2.34c.29 0 .53-.24.53-.53v-.42a.53.53 0 0 0-.53-.53h-1.4v-.6h1.4c.29 0 .53-.23.53-.52v-.42a.53.53 0 0 0-.53-.53h-1.4v-.6h1.4c.29 0 .53-.24.53-.53v-.42a.53.53 0 0 0-.53-.53h-2.34Z"
      />
    </svg>
  );
}

export function ShareActions({ shareUrl }: { shareUrl: string }): JSX.Element {
  const [shareState, setShareState] = useState<ShareState>('idle');
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((id) => window.clearTimeout(id));
  }, []);

  const later = useCallback((fn: () => void) => {
    timers.current.push(window.setTimeout(fn, FEEDBACK_MS));
  }, []);

  const copy = useCallback(async (): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      return true;
    } catch {
      return false;
    }
  }, [shareUrl]);

  async function handleCopy(): Promise<void> {
    const ok = await copy();
    setCopyState(ok ? 'copied' : 'error');
    later(() => setCopyState('idle'));
  }

  async function handleShare(): Promise<void> {
    const outcome = await shareOrCopy(shareUrl, BOX_SHARE_COPY);
    if (outcome === 'error') {
      setCopyState('error');
      later(() => setCopyState('idle'));
      return;
    }
    setShareState(outcome === 'shared' ? 'sent' : 'copied');
    later(() => setShareState('idle'));
  }

  function shareViaLine(): void {
    const url =
      'https://social-plugins.line.me/lineit/share' +
      `?url=${encodeURIComponent(shareUrl)}` +
      `&text=${encodeURIComponent('มีกล่องของขวัญรอคุณอยู่ 🎁')}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  const shareLabel =
    shareState === 'sent' ? 'ส่งแล้ว ✓' : shareState === 'copied' ? 'คัดลอกลิงก์แล้ว ✓' : 'แชร์ 🎁';
  const copyLabel =
    copyState === 'copied' ? 'คัดลอกแล้ว ✓' : copyState === 'error' ? 'ลองใหม่' : 'คัดลอกลิงก์';

  return (
    <div className={styles.shareActions}>
      <div className={styles.shareRow}>
        <button
          type="button"
          className={`${styles.navBtn} ${styles.nextBtn}`}
          onClick={() => void handleShare()}
        >
          {shareLabel}
        </button>
        <button
          type="button"
          className={`${styles.navBtn} ${styles.outlineBtn} ${
            copyState === 'copied' ? styles.okBtn : ''
          }`}
          onClick={() => void handleCopy()}
        >
          {copyLabel}
        </button>
      </div>

      <button type="button" className={`${styles.navBtn} ${styles.lineBtn}`} onClick={shareViaLine}>
        <LineLogo />
        แชร์ผ่าน LINE
      </button>

      <div className={styles.shareRow}>
        <a className={`${styles.navBtn} ${styles.ghostBtn}`} href={shareUrl}>
          ดูตัวอย่าง
        </a>
        <a className={`${styles.navBtn} ${styles.ghostBtn}`} href="/dashboard/legacy-box">
          กลับหน้ากล่อง
        </a>
      </div>
    </div>
  );
}
