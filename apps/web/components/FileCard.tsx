'use client';

import { useState } from 'react';
import type { FileDto, FolderDto, TagDto } from '@nookeb/shared';
import {
  attachTag,
  deleteFile,
  detachTag,
  exportToDrive,
  moveFile,
  renameFile,
  startDownload,
} from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { typeBadge } from '@/lib/filetype';
import { DotsIcon, DownloadIcon, EyeIcon } from './icons';

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
  driveConnected?: boolean;
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
  driveConnected,
  onChanged,
  onPreview,
  view = 'grid',
  selectMode = false,
  selected = false,
  onToggleSelect,
}: FileCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
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

  async function handleExportDrive(): Promise<void> {
    setBusy(true);
    try {
      const { link } = await exportToDrive(file.id);
      window.open(link, '_blank', 'noreferrer');
    } catch {
      alert('ส่งออกไป Google Drive ไม่สำเร็จ');
    } finally {
      setBusy(false);
      setMenuOpen(false);
    }
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
          className="btn secondary small"
          disabled={busy}
          onClick={() => void startDownload(file.id)}
        >
          ดาวน์โหลด
        </button>
      )}
      {driveConnected && file.status === 'ready' && (
        <button className="btn secondary small" disabled={busy} onClick={() => void handleExportDrive()}>
          ส่งออก Google Drive
        </button>
      )}
      <button className="btn danger small" disabled={busy} onClick={handleDelete}>
        ลบไฟล์
      </button>
    </div>
  );

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
                className="icon-btn"
                aria-label="ดาวน์โหลด"
                onClick={() => void startDownload(file.id)}
              >
                <DownloadIcon />
              </button>
            </>
          )}
          <button className="icon-btn" aria-label="เมนูจัดการไฟล์" onClick={() => setMenuOpen((v) => !v)}>
            <DotsIcon />
          </button>
        </div>
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
    </div>
  );
}
