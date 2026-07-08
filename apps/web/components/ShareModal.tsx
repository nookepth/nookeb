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

const DURATIONS: { id: ShareExpiresIn; label: string }[] = [
  { id: '1h', label: '1 ชั่วโมง' },
  { id: '24h', label: '24 ชั่วโมง' },
  { id: '7d', label: '7 วัน' },
  { id: 'never', label: 'ตลอดไป' },
];

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

export interface ShareModalProps {
  file: FileDto;
  onClose: () => void;
}

export function ShareModal({ file, onClose }: ShareModalProps) {
  const [duration, setDuration] = useState<ShareExpiresIn>('7d');
  const [shares, setShares] = useState<ShareDto[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The most recently created link — highlighted at the top of the modal.
  const [justCreated, setJustCreated] = useState<ShareDto | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

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
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal share-modal" onClick={(e) => e.stopPropagation()}>
        <div className="share-modal-head">
          <h3 className="modal-title">แชร์ไฟล์: {file.name}</h3>
          <button className="icon-btn" aria-label="ปิด" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="share-section">
          <span className="share-section-label">ระยะเวลาการแชร์</span>
          <div className="share-duration-grid" role="radiogroup" aria-label="ระยะเวลาการแชร์">
            {DURATIONS.map((d) => (
              <button
                key={d.id}
                role="radio"
                aria-checked={duration === d.id}
                className={`share-duration ${duration === d.id ? 'active' : ''}`}
                onClick={() => setDuration(d.id)}
                disabled={creating}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>

        <button className="btn" onClick={() => void handleCreate()} disabled={creating}>
          {creating ? 'กำลังสร้าง...' : 'สร้างลิงก์'}
        </button>

        {error && <p className="share-error">{error}</p>}

        {justCreated && (
          <div className="share-created">
            <div className="share-link-row">
              <input className="share-link-input" readOnly value={justCreated.shareUrl} />
              <button
                className="btn secondary small"
                onClick={() => void handleCopy(justCreated)}
              >
                <CopyIcon /> {copiedToken === justCreated.token ? 'คัดลอกแล้ว' : 'คัดลอก'}
              </button>
            </div>
            <div className="share-link-meta">หมดอายุ: {expiryLabel(justCreated.expiresAt)}</div>
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
