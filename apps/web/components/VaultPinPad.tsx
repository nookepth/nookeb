'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * 6-digit PIN pad for ห้องนิรภัย — numpad-only by design (no <input>, no
 * keyboard events), which keeps the PIN out of autofill/IME/keylogger
 * surfaces. Auto-submits on the 6th digit; the parent clears it by bumping
 * `resetKey` (e.g. after a wrong PIN).
 */

const PIN_LENGTH = 6;

interface VaultPinPadProps {
  title: string;
  subtitle?: string;
  /** Fired once, automatically, when the 6th digit is entered. */
  onSubmit: (pin: string) => void;
  /** Bump to clear the entered digits (wrong PIN, step change). */
  resetKey?: number;
  /** Disables all keys (while verifying, or during lockout). */
  disabled?: boolean;
  error?: string | null;
  /** Seconds until a PIN lockout lifts — shows a countdown instead of the error. */
  lockRemaining?: number | null;
}

function formatLock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m} นาที ${s} วินาที` : `${s} วินาที`;
}

export function VaultPinPad({
  title,
  subtitle,
  onSubmit,
  resetKey = 0,
  disabled = false,
  error,
  lockRemaining,
}: VaultPinPadProps) {
  const [pin, setPin] = useState('');

  useEffect(() => {
    setPin('');
  }, [resetKey]);

  useEffect(() => {
    if (pin.length === PIN_LENGTH) onSubmit(pin);
    // onSubmit is intentionally not a dep — parents pass inline handlers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  const locked = typeof lockRemaining === 'number' && lockRemaining > 0;
  const keysDisabled = disabled || locked;

  const press = useCallback(
    (digit: string) => {
      setPin((p) => (p.length < PIN_LENGTH ? p + digit : p));
    },
    [],
  );

  return (
    <div className="vault-pinpad">
      <h2 className="vault-pinpad-title">{title}</h2>
      {subtitle && <p className="vault-pinpad-subtitle">{subtitle}</p>}

      <div className="vault-pin-dots" role="status" aria-label={`กรอกแล้ว ${pin.length} จาก 6 หลัก`}>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span key={i} className={`vault-pin-dot${i < pin.length ? ' filled' : ''}`} />
        ))}
      </div>

      {locked ? (
        <p className="vault-pinpad-error">
          ล็อคชั่วคราว — ลองใหม่ได้ในอีก {formatLock(lockRemaining)}
        </p>
      ) : error ? (
        <p className="vault-pinpad-error">{error}</p>
      ) : (
        <p className="vault-pinpad-hint">&nbsp;</p>
      )}

      <div className="vault-numpad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button
            key={d}
            type="button"
            className="vault-numpad-key"
            disabled={keysDisabled}
            onClick={() => press(d)}
          >
            {d}
          </button>
        ))}
        <span aria-hidden className="vault-numpad-spacer" />
        <button
          type="button"
          className="vault-numpad-key"
          disabled={keysDisabled}
          onClick={() => press('0')}
        >
          0
        </button>
        <button
          type="button"
          className="vault-numpad-key vault-numpad-back"
          disabled={keysDisabled || pin.length === 0}
          onClick={() => setPin((p) => p.slice(0, -1))}
          aria-label="ลบตัวสุดท้าย"
        >
          ⌫
        </button>
      </div>
    </div>
  );
}
