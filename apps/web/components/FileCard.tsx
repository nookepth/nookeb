'use client';

import { useState } from 'react';
import type { FileDto, FolderDto, TagDto } from '@nookeb/shared';
import {
  attachTag,
  deleteFile,
  detachTag,
  moveFile,
  renameFile,
  startDownload,
} from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { typeBadge } from '@/lib/filetype';
import { DotsIcon, DownloadIcon, EyeIcon, ShareIcon } from './icons';
import { ShareModal } from './ShareModal';

const STATUS_LABEL: Record<FileDto['status'], string> = {
  pending: 'รอคิว',
  processing: 'กำลังเก็บ...',
  ready: 'พร้อมใช้',
  error: 'ผิดพลาด',
};

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: '2-digit',
  });
}

function ThumbArea({ file, children }: { file: FileDto; children?: React.ReactNode }) {
  const badge = typeBadge(file);
  return (
    <div className="thumb-area" style={file.thumbnailUrl ? undefined : { background: `${badge.color}14` }}>
      {file.thumbnailUrl ? (
        <img className="thumb" src={file.thumbnailUrl} alt={file.name} loading="lazy" />
      ) : (
        <span className="type-badge" style={{ background: badge.color }}>
          {badge.label}
        </span>
      )}
      {children}
    </div>
  );
}

export interface FileCardProps {
  file: FileDto;
  folders: FolderDto[];
  tags: TagDto[];
  onChanged: () => void;
  /** Open the preview modal for this file. */
  onPreview?: (file: FileDto) => void;
  /** 'grid' renders a card, 'list' renders a full-width row. */
  view?: 'grid' | 'list';
  /** When true, the card acts as a selection toggle instead of opening the file. */
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}

export function FileCard({
  file,
  folders,
  tags,
  onChanged,
  onPreview,
  view = 'grid',
  selectMode = false,
  selected = false,
  onToggleSelect,
}: FileCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileTags = tags.filter((t) => (file.tagIds ?? []).includes(t.id));
  const badge = typeBadge(file);

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch {
      alert('ทำรายการไม่สำเร็จ ลองอีกครั้งนะ');
    } finally {
      setBusy(false);
      setMenuOpen(false);
    }
  }

  function handleRename(): void {
    const name = window.prompt('ชื่อใหม่', file.name);
    if (!name || name === file.name) return;
    void run(() => renameFile(file.id, name));
  }

  function handleMove(targetFolderId: string): void {
    void run(() => moveFile(file.id, targetFolderId === '' ? null : targetFolderId));
  }

  function handleDelete(): void {
    if (!window.confirm(`ลบ "${file.name}" ?`)) return;
    void run(() => deleteFile(file.id));
  }

  function toggleTag(tag: TagDto): void {
    const has = (file.tagIds ?? []).includes(tag.id);
    void run(() => (has ? detachTag(file.id, tag.id) : attachTag(file.id, tag.id)));
  }

  const metaText = `${formatBytes(file.fileSize)} · ${shortDate(file.createdAt)}`;

  /* ---------- selection mode ---------- */

  if (selectMode) {
    if (view === 'list') {
      return (
        <div
          className={`file-row selectable ${selected ? 'selected' : ''}`}
          role="button"
          aria-pressed={selected}
          onClick={() => onToggleSelect?.(file.id)}
        >
          <span className={`select-checkbox static ${selected ? 'checked' : ''}`} aria-hidden="true" />
          {file.thumbnailUrl ? (
            <img className="row-thumb" src={file.thumbnailUrl} alt="" loading="lazy" />
          ) : (
            <span className="row-badge" style={{ background: badge.color }}>
              {badge.label}
            </span>
          )}
          <div className="row-main">
            <div className="name">{file.name}</div>
            <div className="meta">{metaText}</div>
          </div>
        </div>
      );
    }
    return (
      <div
        className={`file-card selectable ${selected ? 'selected' : ''}`}
        role="button"
        aria-pressed={selected}
        onClick={() => onToggleSelect?.(file.id)}
      >
        <span className={`select-checkbox ${selected ? 'checked' : ''}`} aria-hidden="true" />
        <ThumbArea file={file} />
        <div className="card-body">
          <div className="name">{file.name}</div>
          <div className="meta">{metaText}</div>
        </div>
      </div>
    );
  }

  /* ---------- shared menu ---------- */

  const menu = menuOpen && (
    <div className="card-menu">
      <button className="btn secondary small" disabled={busy} onClick={handleRename}>
        เปลี่ยนชื่อ
      </button>
      <select
        className="select"
        disabled={busy}
        value={file.folderId ?? ''}
        onChange={(e) => handleMove(e.target.value)}
      >
        <option value="">ไม่มีโฟลเดอร์</option>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      {tags.length > 0 && (
        <div className="tag-row">
          {tags.map((t) => {
            const active = (file.tagIds ?? []).includes(t.id);
            return (
              <button
                key={t.id}
                className={`tag-chip toggle ${active ? 'active' : ''}`}
                style={active ? { background: t.color } : undefined}
                disabled={busy}
                onClick={() => toggleTag(t)}
              >
                {t.name}
              </button>
            );
          })}
        </div>
      )}
      {file.status === 'ready' && (
        <button
          type="button" // FIX: download - avoid accidental form submit swallowing the tap on iOS
          className="btn secondary small"
          disabled={busy}
          onClick={async (e) => {
            e.stopPropagation(); // FIX: download - don't let a parent handler eat the gesture
            try {
              await startDownload(file.id, file.mimeType); // FIX: download - await so failures surface instead of silently vanishing
            } catch (err) {
              console.error('download failed', err); // FIX: download - was failing silently on iOS
            }
          }}
        >
          ดาวน์โหลด
        </button>
      )}
      {file.status === 'ready' && (
        <button
          type="button"
          className="btn secondary small"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen(false);
            setShareOpen(true);
          }}
        >
          <ShareIcon /> แชร์
        </button>
      )}
      <button className="btn danger small" disabled={busy} onClick={handleDelete}>
        ลบไฟล์
      </button>
    </div>
  );

  const shareModal = shareOpen && <ShareModal file={file} onClose={() => setShareOpen(false)} />;

  /* ---------- list view ---------- */

  if (view === 'list') {
    return (
      <div className="file-row">
        {file.thumbnailUrl ? (
          <img className="row-thumb" src={file.thumbnailUrl} alt="" loading="lazy" />
        ) : (
          <span className="row-badge" style={{ background: badge.color }}>
            {badge.label}
          </span>
        )}
        <div className="row-main">
          <div className="name">{file.name}</div>
          <div className="meta">
            {metaText}
            {file.status !== 'ready' && <> · {STATUS_LABEL[file.status]}</>}
          </div>
          {menu}
        </div>
        <div className="row-actions">
          {file.status === 'ready' && (
            <>
              <button className="icon-btn" aria-label="ดูไฟล์" onClick={() => onPreview?.(file)}>
                <EyeIcon />
              </button>
              <button
                type="button" // FIX: download - avoid accidental form submit swallowing the tap on iOS
                className="icon-btn"
                aria-label="ดาวน์โหลด"
                onClick={async (e) => {
                  e.stopPropagation(); // FIX: download - don't let a parent handler eat the gesture
                  try {
                    await startDownload(file.id, file.mimeType); // FIX: download - await so failures surface instead of silently vanishing
                  } catch (err) {
                    console.error('download failed', err); // FIX: download - was failing silently on iOS
                  }
                }}
              >
                <DownloadIcon />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="แชร์"
                onClick={(e) => {
                  e.stopPropagation();
                  setShareOpen(true);
                }}
              >
                <ShareIcon />
              </button>
            </>
          )}
          <button className="icon-btn" aria-label="เมนูจัดการไฟล์" onClick={() => setMenuOpen((v) => !v)}>
            <DotsIcon />
          </button>
        </div>
        {shareModal}
      </div>
    );
  }

  /* ---------- grid view ---------- */

  return (
    <div className="file-card">
      <ThumbArea file={file}>
        <div className="hover-actions">
          {file.status === 'ready' && (
            <button className="icon-btn" aria-label="ดูไฟล์" onClick={() => onPreview?.(file)}>
              <EyeIcon />
            </button>
          )}
          {file.status === 'ready' && (
            <button
              type="button"
              className="icon-btn"
              aria-label="แชร์"
              onClick={(e) => {
                e.stopPropagation();
                setShareOpen(true);
              }}
            >
              <ShareIcon />
            </button>
          )}
          <button className="icon-btn" aria-label="เมนูจัดการไฟล์" onClick={() => setMenuOpen((v) => !v)}>
            <DotsIcon />
          </button>
        </div>
      </ThumbArea>
      <div className="card-body">
        {file.status !== 'ready' && (
          <div className="card-head">
            <span className={`status-badge ${file.status}`}>{STATUS_LABEL[file.status]}</span>
          </div>
        )}
        <div className="name">{file.name}</div>
        {fileTags.length > 0 && (
          <div className="tag-row">
            {fileTags.map((t) => (
              <span key={t.id} className="tag-chip" style={{ background: t.color }}>
                {t.name}
              </span>
            ))}
          </div>
        )}
        <div className="meta">{metaText}</div>
        {menu}
      </div>
      {shareModal}
    </div>
  );
}
