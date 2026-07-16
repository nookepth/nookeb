'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import type { TrashFileDto, TrashListResponse } from '@nookeb/shared';
import {
  ApiError,
  deleteTrashFilePermanently,
  emptyTrash,
  hasSession,
  listTrash,
  restoreTrashFile,
} from '@/lib/api';
import { startLineLogin } from '@/lib/auth';
import { formatBytes } from '@/lib/format';
import { typeBadge } from '@/lib/filetype';
import { RestoreIcon, TrashIcon } from '@/components/icons';

/** Matches GET /trash's default `limit`. */
const PAGE_SIZE = 40;

function deletedAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'ลบเมื่อวันนี้';
  if (days === 1) return 'ลบเมื่อเมื่อวาน';
  return `ลบเมื่อ ${days} วันที่แล้ว`;
}

function purgeCountdown(days: number): string {
  if (days <= 0) return 'จะถูกลบถาวรเร็วๆ นี้';
  return `จะถูกลบถาวรใน ${days} วัน`;
}

type ConfirmAction =
  | { kind: 'permanent'; file: TrashFileDto }
  | { kind: 'empty' }
  | { kind: 'quota' };

export default function TrashPage() {
  const [data, setData] = useState<TrashListResponse | null>(null);
  const [page, setPage] = useState(1);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string): void {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  const load = useCallback(async () => {
    if (!hasSession()) {
      setNeedsLogin(true);
      return;
    }
    try {
      const res = await listTrash(page, PAGE_SIZE);
      setData(res);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedsLogin(true);
      else setError('โหลดถังขยะไม่สำเร็จ ลองรีเฟรชอีกครั้งน้า');
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  async function handleRestore(file: TrashFileDto): Promise<void> {
    setBusyId(file.id);
    try {
      const res = await restoreTrashFile(file.id);
      showToast(`กู้คืนแล้ว ไฟล์อยู่ใน ${res.folderName ?? 'คลังหลัก'}`);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'QUOTA_EXCEEDED') {
        setConfirm({ kind: 'quota' });
      } else if (err instanceof ApiError && err.status === 401) {
        setNeedsLogin(true);
      } else {
        showToast(err instanceof ApiError ? err.message : 'กู้คืนไม่สำเร็จ ลองใหม่อีกครั้งน้า');
        await load();
      }
    } finally {
      setBusyId(null);
    }
  }

  async function handlePermanentDelete(file: TrashFileDto): Promise<void> {
    setConfirm(null);
    setBusyId(file.id);
    try {
      await deleteTrashFilePermanently(file.id);
      showToast('ลบถาวรแล้ว');
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedsLogin(true);
      else showToast('ลบถาวรไม่สำเร็จ ลองใหม่อีกครั้งน้า');
    } finally {
      setBusyId(null);
    }
  }

  async function handleEmptyTrash(): Promise<void> {
    setConfirm(null);
    setBusyId('__empty__');
    try {
      const res = await emptyTrash();
      showToast(`ลบถาวรแล้ว ${res.count} ไฟล์`);
      setPage(1);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedsLogin(true);
      else showToast('ล้างถังขยะไม่สำเร็จ ลองใหม่อีกครั้งน้า');
      await load();
    } finally {
      setBusyId(null);
    }
  }

  if (needsLogin) {
    return (
      <div className="center-page">
        <Image src="/logo.png" alt="หนูเก็บ" width={120} height={120} className="login-logo" priority />
        <h1>หนูเก็บ</h1>
        <p>เข้าสู่ระบบด้วย LINE เพื่อเปิดถังขยะของคุณ</p>
        <button className="btn" onClick={startLineLogin}>
          เข้าสู่ระบบด้วย LINE
        </button>
      </div>
    );
  }

  const files = data?.files ?? [];
  const retentionDays = data?.retentionDays ?? 5;

  return (
    <main className="container trash-container">
      <header className="trash-header">
        <a className="trash-back" href="/dashboard">
          ← กลับคลัง
        </a>
        <h1 className="trash-title">
          <span className="trash-title-icon">
            <TrashIcon size={26} />
          </span>
          ถังขยะ{data ? ` (${data.total} ไฟล์)` : ''}
          {data?.plan === 'pro' && <span className="trash-pro-badge">Pro — เก็บไว้ {retentionDays} วัน</span>}
        </h1>
        <p className="trash-hint">ไฟล์ที่ลบจะอยู่ที่นี่ {retentionDays} วันก่อนถูกลบถาวร</p>
      </header>

      {data?.plan === 'free' && (
        <div className="trash-upsell">
          <span>อัปเกรดเป็น Pro เพื่อเก็บไฟล์ในถังขยะ 30 วัน</span>
          <button className="btn secondary small" disabled title="เร็วๆ นี้">
            อัปเกรด (เร็วๆ นี้)
          </button>
        </div>
      )}

      {error && <p className="empty-state">{error}</p>}

      {!error && data === null && (
        <div className="file-grid" aria-label="กำลังโหลด" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="skeleton-card">
              <div className="skeleton skeleton-thumb" />
              <div className="skeleton skeleton-line" />
              <div className="skeleton skeleton-line short" />
            </div>
          ))}
        </div>
      )}

      {!error && data !== null && files.length === 0 && (
        <div className="trash-empty-state">
          <span className="trash-empty-icon">
            <TrashIcon size={56} />
          </span>
          <h2>ถังขยะว่างเปล่า</h2>
          <p>ไฟล์ที่ลบจะอยู่ที่นี่ {retentionDays} วันก่อนถูกลบถาวร</p>
        </div>
      )}

      {!error && files.length > 0 && (
        <>
          <div className="trash-toolbar">
            <button
              className="btn danger small"
              disabled={busyId !== null}
              onClick={() => setConfirm({ kind: 'empty' })}
            >
              ล้างถังขยะ
            </button>
          </div>

          <div className="file-grid">
            {files.map((file) => {
              const badge = typeBadge({ mimeType: file.mimeType, extension: null, name: file.name });
              const busy = busyId === file.id || busyId === '__empty__';
              return (
                <div key={file.id} className="file-card trash-card">
                  <div
                    className="thumb-area"
                    style={file.thumbnailUrl ? undefined : { background: `${badge.color}14` }}
                  >
                    {file.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- presigned R2 URL, not a static asset
                      <img className="thumb" src={file.thumbnailUrl} alt={file.name} loading="lazy" />
                    ) : (
                      <span className="type-badge" style={{ background: badge.color }}>
                        {badge.label}
                      </span>
                    )}
                  </div>
                  <div className="card-body">
                    <div className="name">{file.name}</div>
                    <div className="meta">
                      {formatBytes(file.fileSize)} · {deletedAgo(file.deletedAt)}
                    </div>
                    <div className={`trash-countdown ${file.daysUntilPurge <= 1 ? 'warn' : ''}`}>
                      {purgeCountdown(file.daysUntilPurge)}
                    </div>
                    <div className="trash-card-actions">
                      <button
                        className="btn secondary small"
                        disabled={busy}
                        onClick={() => void handleRestore(file)}
                      >
                        <RestoreIcon /> กู้คืน
                      </button>
                      <button
                        className="btn danger small"
                        disabled={busy}
                        onClick={() => setConfirm({ kind: 'permanent', file })}
                      >
                        ลบถาวร
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {totalPages > 1 && (
            <nav className="pagination" aria-label="แบ่งหน้า">
              <button className="btn secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                ← ก่อนหน้า
              </button>
              <span className="page-indicator" aria-live="polite">
                หน้า {page} / {totalPages}
              </span>
              <button
                className="btn secondary"
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
              >
                ถัดไป →
              </button>
            </nav>
          )}
        </>
      )}

      {/* ---------- confirmation / quota modals ---------- */}
      {confirm && (
        <div className="modal-overlay" onClick={() => setConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            {confirm.kind === 'permanent' && (
              <>
                <h2>ลบถาวร?</h2>
                <p>
                  ลบ &quot;{confirm.file.name}&quot; ถาวร? ไม่สามารถกู้คืนได้อีก
                </p>
                <div className="modal-actions">
                  <button className="btn secondary" onClick={() => setConfirm(null)}>
                    ยกเลิก
                  </button>
                  <button className="btn danger" onClick={() => void handlePermanentDelete(confirm.file)}>
                    ลบถาวร
                  </button>
                </div>
              </>
            )}
            {confirm.kind === 'empty' && (
              <>
                <h2>ล้างถังขยะ?</h2>
                <p>ลบไฟล์ทั้งหมด {data?.total ?? 0} ไฟล์ถาวร? ไม่สามารถกู้คืนได้</p>
                <div className="modal-actions">
                  <button className="btn secondary" onClick={() => setConfirm(null)}>
                    ยกเลิก
                  </button>
                  <button className="btn danger" onClick={() => void handleEmptyTrash()}>
                    ล้างถังขยะ
                  </button>
                </div>
              </>
            )}
            {confirm.kind === 'quota' && (
              <>
                <h2>พื้นที่ไม่พอ</h2>
                <p>พื้นที่ไม่พอ โปรดลบไฟล์อื่นก่อน แล้วลองกู้คืนใหม่อีกครั้งน้า</p>
                <div className="modal-actions">
                  <button className="btn" onClick={() => setConfirm(null)}>
                    เข้าใจแล้ว
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {toast && (
        <div className="trash-toast" role="status">
          {toast}
        </div>
      )}
    </main>
  );
}
