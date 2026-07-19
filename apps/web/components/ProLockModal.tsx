'use client';

import styles from './ProLockModal.module.css';

/**
 * Shared Pro fake-door lock modal, extracted from the gift-box create flow so
 * the ระบบตามงาน (Task Manager) pages reuse the exact same pattern instead of
 * duplicating it. UI only — it knows nothing about which demand-test endpoint
 * records the tap; the parent supplies onNotify. Theme accent comes from the
 * `accent` prop (a CSS colour or a `var(--x)` reference), so gift-box passes its
 * yellow and tasks pass brand red without the component hard-coding either.
 *
 * Brand rule: no emoji — the lock/check are inline SVGs.
 */

function LockGlyph() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="15.2" r="1.1" fill="currentColor" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="m5 12.5 4.5 4.5L19 7.5"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export interface ProLockModalProps {
  open: boolean;
  title: string;
  subtitle: string;
  /** Primary CTA label (e.g. "แจ้งเตือนฉัน"). */
  ctaLabel: string;
  dismissLabel?: string;
  /** When true the CTA is replaced by the confirmation line. */
  notified: boolean;
  notifiedLabel: string;
  /** Disable the CTA while the interest POST is in flight. */
  busy?: boolean;
  /** CSS colour or `var(--x)` reference used for the accent. */
  accent?: string;
  onNotify: () => void;
  onDismiss: () => void;
}

export function ProLockModal({
  open,
  title,
  subtitle,
  ctaLabel,
  dismissLabel = 'ปิด',
  notified,
  notifiedLabel,
  busy = false,
  accent,
  onNotify,
  onDismiss,
}: ProLockModalProps) {
  if (!open) return null;
  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="pro-lock-title"
      style={accent ? ({ ['--pro-accent']: accent } as React.CSSProperties) : undefined}
      onClick={onDismiss}
    >
      {/* stop the backdrop's dismiss from firing on clicks inside the panel */}
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <span className={styles.icon} aria-hidden>
          <LockGlyph />
        </span>
        <h2 className={styles.title} id="pro-lock-title">
          {title}
        </h2>
        <p className={styles.text}>{subtitle}</p>
        <div className={styles.actions}>
          {notified ? (
            <div className={styles.notified} role="status">
              <CheckGlyph />
              {notifiedLabel}
            </div>
          ) : (
            <button type="button" className={styles.primary} onClick={onNotify} disabled={busy}>
              {ctaLabel}
            </button>
          )}
          <button type="button" className={styles.secondary} onClick={onDismiss}>
            {dismissLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
