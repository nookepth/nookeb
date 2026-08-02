'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import {
  ApiError,
  VaultPinError,
  deleteVaultFile,
  getVaultStatus,
  hasSession,
  listVaultFiles,
  listVaultTrash,
  lockVault,
  purgeVaultFile,
  restoreVaultFile,
  setupVaultPin,
  unlockVault,
  uploadVaultFile,
  vaultViewUrl,
  type VaultFileDto,
  type VaultStatus,
  type VaultTrashFileDto,
  type VaultTrashResponse,
} from '@/lib/api';
import { startLineLogin } from '@/lib/auth';
import { formatBytes } from '@/lib/format';
import { CapacityFullModal } from '@/components/UpgradeModal';
import { VaultPinPad } from '@/components/VaultPinPad';

/**
 * ห้องนิรภัย (Vault) — PIN-protected, view-only file store.
 * Page states (from GET /vault/session-status):
 *   needsLogin → notConfigured → setup (no PIN yet) → PIN entry → grid.
 *
 * There is NO premium gate: every plan may use the vault. A plan changes only
 * the file-count CEILING (free 10 / pro 30 / premium 100), which arrives on the
 * status payload as vaultFileLimit / vaultFileCount / vaultSlotsRemaining and
 * is shown above the dropzone.
 *
 * All view URLs stream through the API per request — nothing here ever holds
 * a shareable file URL.
 */

const PAGE_SIZE = 20;
/** ≤ this many slots left → the amber warning. */
const LOW_SLOTS_AT = 3;
const MAX_UPLOAD_MB = 100; // UX-only mirror of VAULT_MAX_FILE_SIZE_MB — server re-validates
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  'application/pdf',
]);
const WARN_AT_SECONDS = 120;

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The file-count ceiling answers with TWO names for the same 403 — the original
 * `code: 'VAULT_FULL'` and the newer `errorCode: 'VAULT_FILE_LIMIT_REACHED'`
 * (routes/vault.ts). Match both so neither spelling falls through to the generic
 * error box, which would render an empty message.
 */
function isVaultFullError(err: ApiError): boolean {
  return err.code === 'VAULT_FULL' || err.code === 'VAULT_FILE_LIMIT_REACHED';
}

function fileKind(mime: string): 'image' | 'video' | 'pdf' {
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  return 'image';
}

export default function VaultPage() {
  const [needsLogin, setNeedsLogin] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  // PIN pad state (shared across unlock / setup / delete-confirm)
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinResetKey, setPinResetKey] = useState(0);
  const [lockRemaining, setLockRemaining] = useState<number | null>(null);

  // setup flow (enter → confirm)
  const [setupFirstPin, setSetupFirstPin] = useState<string | null>(null);

  // unlocked state
  const [files, setFiles] = useState<VaultFileDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [viewer, setViewer] = useState<VaultFileDto | null>(null);
  const [deleting, setDeleting] = useState<VaultFileDto | null>(null);
  const [uploadState, setUploadState] = useState<{ label: string; percent: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  /**
   * §10 — the vault is full (403 VAULT_FULL). A CEILING on live files, not a
   * monthly quota, so it gets the capacity card: deleting frees a slot now, and
   * waiting for the 1st would do nothing. Both the upload and the trash-restore
   * paths can hit it, so the state lives here rather than in either handler.
   */
  const [capacityGate, setCapacityGate] = useState<{ limit?: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // ถังขยะห้องนิรภัย — lives here, behind the unlock session, and never in the
  // general /dashboard/trash page (a vault filename is sensitive content).
  const [trash, setTrash] = useState<VaultTrashResponse | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [trashError, setTrashError] = useState<string | null>(null);
  /**
   * The trash row awaiting a ลบถาวร confirmation. Irreversible, so it goes
   * through the same PIN pad as the soft delete rather than a bare confirm —
   * "unlocked 12 minutes ago" is not consent to destroy something.
   */
  const [purging, setPurging] = useState<VaultTrashFileDto | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const clearPinFeedback = useCallback(() => {
    setPinError(null);
    setLockRemaining(null);
    setPinResetKey((k) => k + 1);
  }, []);

  const applyStatus = useCallback((s: VaultStatus) => {
    setStatus(s);
    setExpiresAt(s.isUnlocked && s.expiresIn !== null ? Date.now() + s.expiresIn * 1000 : null);
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!hasSession()) {
      setNeedsLogin(true);
      return;
    }
    try {
      applyStatus(await getVaultStatus());
      setPageError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedsLogin(true);
      else if (err instanceof ApiError && err.code === 'VAULT_NOT_CONFIGURED') setNotConfigured(true);
      else setPageError('โหลดห้องนิรภัยไม่สำเร็จ ลองรีเฟรชอีกครั้งน้า');
    }
  }, [applyStatus]);

  const loadFiles = useCallback(async (targetPage: number, append: boolean) => {
    try {
      const res = await listVaultFiles(targetPage, PAGE_SIZE);
      setFiles((prev) => (append ? [...prev, ...res.files] : res.files));
      setTotal(res.total);
      setPage(targetPage);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VAULT_LOCKED') {
        setStatus((s) => (s ? { ...s, isUnlocked: false } : s));
        setExpiresAt(null);
      } else {
        setPageError('โหลดไฟล์ไม่สำเร็จ ลองรีเฟรชอีกครั้งน้า');
      }
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // Resync unlock TTL every 60s (the status read never slides the session).
  useEffect(() => {
    const id = setInterval(() => void refreshStatus(), 60_000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  // 1s tick for the countdown + lockout timer.
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
      setLockRemaining((r) => (r !== null && r > 0 ? r - 1 : r));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const loadTrash = useCallback(async () => {
    try {
      setTrash(await listVaultTrash());
    } catch {
      // Non-fatal: the vault's own trash is a secondary panel. A failure here
      // must never blank the file grid the user actually came for.
      setTrash(null);
    }
  }, []);

  useEffect(() => {
    if (status?.isUnlocked) {
      void loadFiles(1, false);
      void loadTrash();
    }
  }, [status?.isUnlocked, loadFiles, loadTrash]);

  async function handleRestore(fileId: string): Promise<void> {
    setRestoring(fileId);
    setTrashError(null);
    try {
      await restoreVaultFile(fileId);
      await Promise.all([loadFiles(1, false), loadTrash()]);
    } catch (err) {
      if (err instanceof ApiError && isVaultFullError(err)) {
        setCapacityGate({ limit: err.details?.limit });
      } else {
        setTrashError('กู้คืนไม่สำเร็จ ลองใหม่อีกทีน้า');
      }
    } finally {
      setRestoring(null);
    }
  }

  /**
   * ลบถาวร — R2 object + row gone, no undo. A 404 means the daily purge (or
   * another tab) already took it, which is the outcome the user asked for, so
   * it closes the dialog quietly instead of erroring — same rule as
   * handleDeleteConfirm.
   */
  async function handlePurgeConfirm(pin: string): Promise<void> {
    if (!purging) return;
    setPinBusy(true);
    setTrashError(null);
    try {
      await purgeVaultFile(purging.id, pin);
      clearPinFeedback();
      setPurging(null);
      await loadTrash();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setPurging(null);
        clearPinFeedback();
        await loadTrash();
      } else {
        handlePinFailure(err);
      }
    } finally {
      setPinBusy(false);
    }
  }

  const remainingSeconds =
    expiresAt !== null ? Math.max(0, Math.round((expiresAt - now) / 1000)) : null;

  /**
   * §10 capacity — the ONLY thing a plan changes about the vault. -1 is the
   * UNLIMITED sentinel from config/plans.ts and must never be rendered as a
   * number, so it is folded into a boolean here rather than at each use.
   */
  const fileLimit = status?.vaultFileLimit ?? 0;
  const fileCount = status?.vaultFileCount ?? 0;
  const unlimitedSlots = fileLimit < 0;
  const slotsRemaining = Math.max(0, status?.vaultSlotsRemaining ?? 0);
  const vaultFull = !unlimitedSlots && slotsRemaining === 0;

  // Auto-lock when the countdown hits zero.
  useEffect(() => {
    if (status?.isUnlocked && remainingSeconds === 0) {
      setStatus((s) => (s ? { ...s, isUnlocked: false } : s));
      setExpiresAt(null);
      setViewer(null);
      setDeleting(null);
      setFiles([]);
      // Drop the trash listing too — it carries filenames, and the session that
      // authorised showing them has just expired.
      setTrash(null);
      setTrashOpen(false);
      setPurging(null);
      void lockVault().catch(() => {});
    }
  }, [remainingSeconds, status?.isUnlocked]);

  function handlePinFailure(err: unknown): void {
    if (err instanceof VaultPinError) {
      if (err.retryAfterSeconds) {
        setLockRemaining(err.retryAfterSeconds);
        setPinError(null);
      } else {
        setPinError(
          err.attemptsRemaining !== undefined
            ? `PIN ไม่ถูกต้อง — เหลืออีก ${err.attemptsRemaining} ครั้ง`
            : 'PIN ไม่ถูกต้อง',
        );
      }
    } else if (err instanceof ApiError && err.status === 401) {
      setNeedsLogin(true);
    } else {
      setPinError('เกิดข้อผิดพลาด ลองใหม่อีกครั้งน้า');
    }
    setPinResetKey((k) => k + 1);
  }

  async function handleUnlock(pin: string): Promise<void> {
    setPinBusy(true);
    try {
      const res = await unlockVault(pin);
      clearPinFeedback();
      setStatus((s) => (s ? { ...s, isUnlocked: true } : s));
      setExpiresAt(Date.now() + res.expiresIn * 1000);
    } catch (err) {
      handlePinFailure(err);
    } finally {
      setPinBusy(false);
    }
  }

  async function handleSetupStep(pin: string): Promise<void> {
    if (setupFirstPin === null) {
      setSetupFirstPin(pin);
      setPinError(null);
      setPinResetKey((k) => k + 1);
      return;
    }
    if (pin !== setupFirstPin) {
      setSetupFirstPin(null);
      setPinError('PIN ไม่ตรงกัน — เริ่มใหม่อีกครั้งน้า');
      setPinResetKey((k) => k + 1);
      return;
    }
    setPinBusy(true);
    try {
      await setupVaultPin(pin);
      // Freshly set PIN — unlock in the same motion so the user lands in the vault.
      const res = await unlockVault(pin);
      clearPinFeedback();
      setSetupFirstPin(null);
      setStatus((s) => (s ? { ...s, hasPin: true, isUnlocked: true } : s));
      setExpiresAt(Date.now() + res.expiresIn * 1000);
    } catch (err) {
      setSetupFirstPin(null);
      handlePinFailure(err);
    } finally {
      setPinBusy(false);
    }
  }

  async function handleDeleteConfirm(pin: string): Promise<void> {
    if (!deleting) return;
    setPinBusy(true);
    try {
      await deleteVaultFile(deleting.id, pin);
      clearPinFeedback();
      setFiles((prev) => prev.filter((f) => f.id !== deleting.id));
      setTotal((t) => Math.max(0, t - 1));
      setViewer((v) => (v?.id === deleting.id ? null : v));
      setDeleting(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setFiles((prev) => prev.filter((f) => f.id !== deleting.id));
        setDeleting(null);
        clearPinFeedback();
      } else {
        handlePinFailure(err);
      }
    } finally {
      setPinBusy(false);
    }
  }

  async function handleLock(): Promise<void> {
    setViewer(null);
    setDeleting(null);
    setFiles([]);
    setStatus((s) => (s ? { ...s, isUnlocked: false } : s));
    setExpiresAt(null);
    clearPinFeedback();
    await lockVault().catch(() => {});
  }

  /** Any authenticated vault call slides the server TTL — then resync. */
  async function extendSession(): Promise<void> {
    try {
      await listVaultFiles(1, 1);
      await refreshStatus();
    } catch {
      /* refreshStatus surfaces the failure states */
    }
  }

  async function handleFiles(list: FileList | File[]): Promise<void> {
    // Already at the ceiling — say so without spending a round trip on a 403 we
    // can predict. The server still enforces it (this is UX only).
    if (vaultFull) {
      setCapacityGate({ limit: fileLimit });
      return;
    }
    setUploadError(null);
    const items = Array.from(list);
    for (const [i, file] of items.entries()) {
      if (!ALLOWED_MIME.has(file.type)) {
        setUploadError(`"${file.name}" — ชนิดไฟล์นี้เก็บในห้องนิรภัยไม่ได้ (รูป / วิดีโอ / PDF เท่านั้น)`);
        continue;
      }
      if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
        setUploadError(`"${file.name}" ใหญ่เกิน ${MAX_UPLOAD_MB} MB`);
        continue;
      }
      const label = items.length > 1 ? `กำลังอัปโหลด ${i + 1}/${items.length}` : 'กำลังอัปโหลด';
      setUploadState({ label, percent: 0 });
      try {
        await uploadVaultFile(file, (percent) => setUploadState({ label, percent }));
      } catch (err) {
        if (err instanceof ApiError && err.code === 'VAULT_LOCKED') {
          setStatus((s) => (s ? { ...s, isUnlocked: false } : s));
          setExpiresAt(null);
          setUploadState(null);
          return;
        }
        // §10 — the file-count ceiling. This used to fall through to the line
        // below, which renders `err.message`; parseApiError blanks that field
        // whenever the body carried a bare machine code, so a full vault could
        // report an EMPTY error. Stop uploading the rest of the batch too —
        // every remaining file would hit the same wall.
        if (err instanceof ApiError && isVaultFullError(err)) {
          setCapacityGate({ limit: err.details?.limit });
          setUploadState(null);
          break;
        }
        if (err instanceof ApiError && err.code === 'QUOTA_EXCEEDED') {
          // Personal storage BYTES, not the file count — different advice.
          setUploadError('พื้นที่เก็บไฟล์ไม่พอแล้วน้า ลบไฟล์เก่าหรืออัปเกรดแพลนก่อนน้า');
          setUploadState(null);
          break;
        }
        setUploadError(
          err instanceof ApiError && err.message ? err.message : 'อัปโหลดไม่สำเร็จ',
        );
      }
    }
    setUploadState(null);
    await loadFiles(1, false);
    await refreshStatus();
  }

  /* ---------- render ---------- */

  if (needsLogin) {
    return (
      <div className="center-page">
        <Image src="/logo.png" alt="หนูเก็บ" width={120} height={120} className="login-logo" priority />
        <h1>หนูเก็บ</h1>
        <p>เข้าสู่ระบบด้วย LINE เพื่อเปิดห้องนิรภัยของคุณ</p>
        <button className="btn" onClick={startLineLogin}>
          เข้าสู่ระบบด้วย LINE
        </button>
      </div>
    );
  }

  if (notConfigured) {
    return (
      <main className="container vault-container">
        <VaultHeader />
        <div className="vault-state-card">
          <h2>ห้องนิรภัยยังไม่เปิดให้บริการ</h2>
          <p>ฟีเจอร์นี้กำลังเตรียมเปิดตัว — กลับมาอีกครั้งเร็ว ๆ นี้น้า</p>
        </div>
      </main>
    );
  }

  if (!status) {
    return (
      <main className="container vault-container">
        <VaultHeader />
        {pageError ? <div className="vault-error">{pageError}</div> : <div className="vault-state-card">กำลังโหลด…</div>}
      </main>
    );
  }

  // State: no PIN yet → setup. Open to every plan — setting a PIN buys no tier.
  if (!status.hasPin) {
    return (
      <main className="container vault-container">
        <VaultHeader />
        <div className="vault-state-card">
          <VaultPinPad
            title={setupFirstPin === null ? 'ตั้ง PIN 6 หลัก' : 'ยืนยัน PIN อีกครั้ง'}
            subtitle={
              setupFirstPin === null
                ? 'PIN นี้จะใช้เปิดห้องนิรภัยทุกครั้ง — จำให้ดีน้า รีเซ็ตไม่ได้'
                : 'กรอก PIN เดิมซ้ำเพื่อยืนยัน'
            }
            onSubmit={(pin) => void handleSetupStep(pin)}
            resetKey={pinResetKey}
            disabled={pinBusy}
            error={pinError}
            lockRemaining={lockRemaining}
          />
        </div>
      </main>
    );
  }

  // State: locked → PIN entry.
  if (!status.isUnlocked) {
    return (
      <main className="container vault-container">
        <VaultHeader />
        <div className="vault-state-card">
          <VaultPinPad
            title="กรอก PIN เพื่อเปิดห้องนิรภัย"
            onSubmit={(pin) => void handleUnlock(pin)}
            resetKey={pinResetKey}
            disabled={pinBusy}
            error={pinError}
            lockRemaining={lockRemaining}
          />
        </div>
      </main>
    );
  }

  // State: unlocked → file grid.
  return (
    <main className="container vault-container">
      <VaultHeader>
        <div className="vault-toolbar">
          {remainingSeconds !== null && (
            <span className={`vault-timer${remainingSeconds <= WARN_AT_SECONDS ? ' warning' : ''}`}>
              ล็อคอีกครั้งใน {formatCountdown(remainingSeconds)} นาที
            </span>
          )}
          <button className="vault-lock-btn" onClick={() => void handleLock()}>
            ล็อคเลย
          </button>
        </div>
      </VaultHeader>

      {remainingSeconds !== null && remainingSeconds <= WARN_AT_SECONDS && (
        <button className="vault-extend-banner" onClick={() => void extendSession()}>
          เซสชันจะหมดอายุใน 2 นาที — แตะเพื่อต่อเวลา
        </button>
      )}

      {pageError && <div className="vault-error">{pageError}</div>}

      {/* §10 — slots used / left. Shown on every plan: the vault itself is free,
          only the ceiling differs, so this is the one number a user needs. */}
      <div
        className={`vault-capacity${
          vaultFull ? ' is-full' : !unlimitedSlots && slotsRemaining <= LOW_SLOTS_AT ? ' is-low' : ''
        }`}
      >
        <span className="vault-capacity-count">
          {unlimitedSlots
            ? `ใช้ไปแล้ว ${fileCount} ไฟล์`
            : `ใช้ไปแล้ว ${fileCount} / ${fileLimit} ไฟล์`}
        </span>
        <span className="vault-capacity-note">
          {unlimitedSlots
            ? 'เก็บได้ไม่จำกัด'
            : vaultFull
              ? 'ครบจำนวนแล้ว — อัปเกรดเพื่อเพิ่มพื้นที่'
              : `เหลืออีก ${slotsRemaining} ช่อง`}
        </span>
      </div>

      <div
        className={`vault-dropzone${dragOver ? ' over' : ''}${vaultFull ? ' is-disabled' : ''}`}
        onDragOver={(e) => {
          if (vaultFull) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (vaultFull) return;
          if (e.dataTransfer.files.length > 0) void handleFiles(e.dataTransfer.files);
        }}
      >
        {uploadState ? (
          <div className="vault-upload-progress">
            <span>
              {uploadState.label} ({uploadState.percent}%)
            </span>
            <div className="vault-progress-track">
              <div className="vault-progress-fill" style={{ width: `${uploadState.percent}%` }} />
            </div>
          </div>
        ) : (
          <>
            <p>{vaultFull ? 'ห้องนิรภัยเต็มแล้วน้า' : 'ลากไฟล์มาวาง หรือ'}</p>
            <button
              className="btn"
              disabled={vaultFull}
              onClick={() => fileInputRef.current?.click()}
            >
              เลือกไฟล์
            </button>
            <p className="vault-dropzone-hint">
              {vaultFull
                ? `แพลนนี้เก็บได้ ${fileLimit} ไฟล์ — ลบไฟล์เก่าออก หรืออัปเกรดแพลนเพื่อเพิ่มพื้นที่น้า`
                : `รูป / วิดีโอ / PDF ไม่เกิน ${MAX_UPLOAD_MB} MB — ดูได้อย่างเดียว ดาวน์โหลดหรือแชร์ต่อไม่ได้`}
            </p>
          </>
        )}
        <input
          ref={fileInputRef}
          type="file"
          hidden
          multiple
          disabled={vaultFull}
          accept={[...ALLOWED_MIME].join(',')}
          onChange={(e) => {
            if (e.target.files?.length) void handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {uploadError && <div className="vault-error">{uploadError}</div>}

      {files.length === 0 ? (
        <div className="vault-state-card">ยังไม่มีไฟล์ในห้องนิรภัย — อัปโหลดไฟล์แรกได้เลยน้า</div>
      ) : (
        <div className="vault-grid">
          {files.map((f) => (
            <div key={f.id} className="vault-card">
              <button className="vault-card-media" onClick={() => setViewer(f)}>
                {fileKind(f.mimeType) === 'image' ? (
                  // Watermarked, per-request authenticated stream — never a shareable URL.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={vaultViewUrl(f.id)} alt={f.originalFilename} loading="lazy" />
                ) : (
                  <span className="vault-card-icon">{fileKind(f.mimeType) === 'video' ? '🎬' : '📄'}</span>
                )}
              </button>
              <div className="vault-card-meta">
                <span className="vault-card-name" title={f.originalFilename}>
                  {f.originalFilename}
                </span>
                <span className="vault-card-size">{formatBytes(f.fileSize)}</span>
              </div>
              <button
                className="vault-card-delete"
                aria-label={`ลบ ${f.originalFilename}`}
                onClick={() => {
                  clearPinFeedback();
                  setDeleting(f);
                }}
              >
                ลบ
              </button>
            </div>
          ))}
        </div>
      )}

      {files.length < total && (
        <button className="btn vault-load-more" onClick={() => void loadFiles(page + 1, true)}>
          โหลดเพิ่ม ({files.length}/{total})
        </button>
      )}

      {/* ถังขยะห้องนิรภัย — collapsed by default so the grid stays the focus.
          Rendered only when there is something to restore. */}
      {trash && trash.files.length > 0 && (
        <section className="vault-trash">
          <button
            className="vault-trash-toggle"
            aria-expanded={trashOpen}
            onClick={() => setTrashOpen((o) => !o)}
          >
            ถังขยะห้องนิรภัย ({trash.files.length}) {trashOpen ? '▾' : '▸'}
          </button>

          {trashOpen && (
            <>
              <p className="vault-trash-hint">
                ไฟล์ที่ลบจะเก็บไว้ {trash.retentionDays} วัน แล้วลบถาวรน้า
              </p>
              {trashError && <div className="vault-error">{trashError}</div>}
              <ul className="vault-trash-list">
                {trash.files.map((f) => (
                  <li key={f.id} className="vault-trash-item">
                    <span className="vault-trash-name" title={f.originalFilename}>
                      {f.originalFilename}
                    </span>
                    {/* retentionDays / daysUntilPurge are computed server-side
                        from the caller's plan (free 5 วัน, pro/premium 30) —
                        never hard-coded here, or the countdown would drift from
                        the purge that actually enforces it. */}
                    <span
                      className={`vault-trash-days${f.daysUntilPurge <= 1 ? ' is-urgent' : ''}`}
                    >
                      เหลืออีก {f.daysUntilPurge} วัน
                    </span>
                    <button
                      className="btn secondary"
                      disabled={restoring === f.id}
                      onClick={() => void handleRestore(f.id)}
                    >
                      {restoring === f.id ? 'กำลังกู้คืน…' : 'กู้คืน'}
                    </button>
                    {/* ลบถาวร — icon-only so the reversible action (กู้คืน)
                        stays the visually louder one. No emoji, per the brand
                        rule: inline SVG. */}
                    <button
                      className="vault-trash-purge"
                      type="button"
                      title="ลบถาวร"
                      aria-label={`ลบถาวร ${f.originalFilename}`}
                      disabled={restoring === f.id}
                      onClick={() => {
                        clearPinFeedback();
                        setTrashError(null);
                        setPurging(f);
                      }}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width="16"
                        height="16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M3 6h18" />
                        <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                        <path d="M10 11v6M14 11v6" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {viewer && (
        <div className="vault-viewer" onClick={() => setViewer(null)}>
          <div className="vault-viewer-body" onClick={(e) => e.stopPropagation()}>
            {fileKind(viewer.mimeType) === 'image' && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={vaultViewUrl(viewer.id)} alt={viewer.originalFilename} />
            )}
            {fileKind(viewer.mimeType) === 'video' && (
              <video src={vaultViewUrl(viewer.id)} controls controlsList="nodownload" playsInline />
            )}
            {fileKind(viewer.mimeType) === 'pdf' && (
              <iframe src={vaultViewUrl(viewer.id)} title={viewer.originalFilename} />
            )}
            <div className="vault-viewer-bar">
              <span className="vault-viewer-name">{viewer.originalFilename}</span>
              <button className="vault-viewer-close" onClick={() => setViewer(null)}>
                ปิด
              </button>
            </div>
          </div>
        </div>
      )}

      {deleting && (
        <div className="vault-viewer" onClick={() => setDeleting(null)}>
          <div className="vault-modal" onClick={(e) => e.stopPropagation()}>
            <VaultPinPad
              title="ยืนยันการลบด้วย PIN"
              subtitle={`"${deleting.originalFilename}" จะถูกลบออกจากห้องนิรภัย`}
              onSubmit={(pin) => void handleDeleteConfirm(pin)}
              resetKey={pinResetKey}
              disabled={pinBusy}
              error={pinError}
              lockRemaining={lockRemaining}
            />
            <button className="vault-modal-cancel" onClick={() => setDeleting(null)}>
              ยกเลิก
            </button>
          </div>
        </div>
      )}

      {/* ลบถาวรจากถังขยะ — the warning is stated BEFORE the PIN pad, so the
          irreversibility is read while there is still something to cancel. */}
      {purging && (
        <div className="vault-viewer" onClick={() => setPurging(null)}>
          <div className="vault-modal" onClick={(e) => e.stopPropagation()}>
            <p className="vault-purge-warning">
              ลบถาวรแล้วจะกู้คืนไม่ได้ ยืนยันไหม?
            </p>
            <VaultPinPad
              title="ยืนยันการลบถาวรด้วย PIN"
              subtitle={`"${purging.originalFilename}" จะถูกลบทิ้งอย่างถาวร`}
              onSubmit={(pin) => void handlePurgeConfirm(pin)}
              resetKey={pinResetKey}
              disabled={pinBusy}
              error={pinError}
              lockRemaining={lockRemaining}
            />
            <button className="vault-modal-cancel" onClick={() => setPurging(null)}>
              ยกเลิก
            </button>
          </div>
        </div>
      )}

      {/* §10 — the vault's live-file ceiling (upload or restore). The 403 body
          carries `limit`; the status payload knows it too, so the card can still
          name the ceiling if an older API omitted it. */}
      <CapacityFullModal
        open={capacityGate !== null}
        onClose={() => setCapacityGate(null)}
        feature="vault_files"
        limit={capacityGate?.limit ?? (unlimitedSlots ? undefined : fileLimit)}
        title="ห้องนิรภัยเต็มแล้วน้า"
      />
    </main>
  );
}

function VaultHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header className="vault-header">
      <a className="vault-back" href="/dashboard">
        ← กลับคลัง
      </a>
      <h1 className="vault-title">🔒 ห้องนิรภัย</h1>
      {children}
    </header>
  );
}
