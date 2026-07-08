'use client';

import { useEffect, useState } from 'react';
import type { FileDto } from '@nookeb/shared';
import {
  createShare,
  deleteShare,
  getShares,
  type ShareDto,
  type ShareExpiresIn,
} from '@/lib/api';
import { CloseIcon, CopyIcon } from './icons';
import { typeBadge } from '@/lib/filetype';

// 2x2 duration grid. `value` is the big glyph, `unit` the small caption below it.
const DURATIONS: { id: ShareExpiresIn; value: string; unit: string }[] = [
  { id: '1h', value: '1', unit: 'ชั่วโมง' },
  { id: '24h', value: '24', unit: 'ชั่วโมง' },
  { id: '7d', value: '7', unit: 'วัน' },
  { id: 'never', value: '∞', unit: 'ตลอดไป' },
];

// Small inline icons kept local to the modal (project convention: no emoji, stroke = currentColor).
function LinkIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
    </svg>
  );
}

function CheckIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m5 13 4 4 10-10" />
    </svg>
  );
}

function expiryLabel(expiresAt: string | null): string {
  if (!expiresAt) return 'ตลอดไป';
  return new Date(expiresAt).toLocaleString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Friendly "หมดอายุใน X" copy for the freshly-created link.
function expiryCountdown(expiresAt: string | null): string {
  if (!expiresAt) return 'ลิงก์นี้ไม่มีวันหมดอายุ';
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'ลิงก์หมดอายุแล้ว';
  const hours = Math.round(ms / 3_600_000);
  if (hours >= 24) {
    const days = Math.round(hours / 24);
    return `ลิงก์หมดอายุใน ${days} วัน`;
  }
  return `ลิงก์หมดอายุใน ${Math.max(1, hours)} ชั่วโมง`;
}

export interface ShareModalProps {
  file: FileDto;
  onClose: () => void;
}

export function ShareModal({ file, onClose }: ShareModalProps) {
  const [duration, setDuration] = useState<ShareExpiresIn | null>('7d');
  const [shares, setShares] = useState<ShareDto[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The most recently created link — highlighted at the top of the modal.
  const [justCreated, setJustCreated] = useState<ShareDto | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const badge = typeBadge(file);

  // iOS Safari scroll preservation: pin <body> at the current scroll offset while
  // the modal is open, then restore it on close so the page doesn't jump to top.
  useEffect(() => {
    const scrollY = window.scrollY;
    const body = document.body;
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.width = '100%';
    return () => {
      body.style.position = '';
      body.style.top = '';
      body.style.width = '';
      window.scrollTo(0, scrollY);
    };
  }, []);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let active = true;
    getShares(file.id)
      .then(({ shares }) => {
        if (active) setShares(shares);
      })
      .catch(() => {
        if (active) setError('โหลดลิงก์ที่มีอยู่ไม่สำเร็จ');
      });
    return () => {
      active = false;
    };
  }, [file.id]);

  useEffect(() => {
    if (!copiedToken) return;
    const t = setTimeout(() => setCopiedToken(null), 2000);
    return () => clearTimeout(t);
  }, [copiedToken]);

  async function handleCreate(): Promise<void> {
    if (!duration) return;
    setCreating(true);
    setError(null);
    try {
      const share = await createShare(file.id, duration);
      setJustCreated(share);
      setShares((prev) => [share, ...prev]);
    } catch {
      setError('สร้างลิงก์ไม่สำเร็จ ลองอีกครั้งนะ');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(share: ShareDto): Promise<void> {
    if (!window.confirm('ต้องการลบลิงก์นี้ใช่ไหม? คนที่มีลิงก์จะเปิดไม่ได้อีก')) return;
    try {
      await deleteShare(file.id, share.id);
      setShares((prev) => prev.filter((s) => s.id !== share.id));
      if (justCreated?.id === share.id) setJustCreated(null);
    } catch {
      setError('ลบลิงก์ไม่สำเร็จ ลองอีกครั้งนะ');
    }
  }

  async function handleCopy(share: ShareDto): Promise<void> {
    try {
      await navigator.clipboard.writeText(share.shareUrl);
      setCopiedToken(share.token);
    } catch {
      // Clipboard blocked (e.g. non-HTTPS / permissions) — fall back to select.
      window.prompt('คัดลอกลิงก์นี้', share.shareUrl);
    }
  }

  return (
    <div className="modal-overlay share-overlay" onClick={onClose}>
      <div
        className="modal share-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`แชร์ไฟล์ ${file.name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="share-modal-head">
          <span className="share-file-icon" style={{ background: badge.color }} aria-hidden>
            {badge.label}
          </span>
          <div className="share-modal-heading">
            <h3 className="share-modal-title" title={file.name}>
              {file.name}
            </h3>
            <p className="share-modal-subtitle">เลือกระยะเวลาการแชร์</p>
          </div>
          <button className="share-close-btn" aria-label="ปิด" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="share-section">
          <div className="share-duration-grid" role="radiogroup" aria-label="ระยะเวลาการแชร์">
            {DURATIONS.map((d) => (
              <button
                key={d.id}
                type="button"
                role="radio"
                aria-checked={duration === d.id}
                className={`share-duration ${duration === d.id ? 'active' : ''}`}
                onClick={() => setDuration(d.id)}
                disabled={creating}
              >
                <span className="share-duration-value">{d.value}</span>
                <span className="share-duration-unit">{d.unit}</span>
              </button>
            ))}
          </div>
        </div>

        <button
          className="btn share-generate-btn"
          onClick={() => void handleCreate()}
          disabled={creating || !duration}
        >
          <LinkIcon />
          {creating ? 'กำลังสร้าง...' : 'สร้างลิงก์แชร์'}
        </button>

        {error && <p className="share-error">{error}</p>}

        {justCreated && (
          <div className="share-created">
            <div className="share-link-row">
              <input
                className="share-link-input"
                readOnly
                value={justCreated.shareUrl}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="ลิงก์แชร์"
              />
              <button
                type="button"
                className={`share-copy-btn ${copiedToken === justCreated.token ? 'copied' : ''}`}
                onClick={() => void handleCopy(justCreated)}
                aria-label="คัดลอกลิงก์"
              >
                {copiedToken === justCreated.token ? (
                  <>
                    <CheckIcon /> คัดลอกแล้ว
                  </>
                ) : (
                  <>
                    <CopyIcon /> คัดลอก
                  </>
                )}
              </button>
            </div>
            <div className="share-link-meta">{expiryCountdown(justCreated.expiresAt)}</div>
          </div>
        )}

        {shares.length > 0 && (
          <div className="share-section">
            <span className="share-section-label">ลิงก์ที่มีอยู่</span>
            <ul className="share-list">
              {shares.map((s) => (
                <li key={s.id} className="share-list-item">
                  <div className="share-list-info">
                    <span className="share-list-expiry">{expiryLabel(s.expiresAt)}</span>
                    <span className="share-list-views">ดู {s.viewCount} ครั้ง</span>
                  </div>
                  <div className="share-list-actions">
                    <button
                      className="btn secondary small"
                      onClick={() => void handleCopy(s)}
                      aria-label="คัดลอกลิงก์"
                    >
                      {copiedToken === s.token ? 'คัดลอกแล้ว' : 'คัดลอก'}
                    </button>
                    <button
                      className="btn danger small"
                      onClick={() => void handleDelete(s)}
                      aria-label="ลบลิงก์"
                    >
                      ลบ
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
