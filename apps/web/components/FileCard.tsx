'use client';

import { useState } from 'react';
import type { FileDto, FolderDto, TagDto } from '@nookeb/shared';
import {
  attachTag,
  deleteFile,
  detachTag,
  downloadUrl,
  exportToDrive,
  moveFile,
  renameFile,
} from '@/lib/api';

const STATUS_LABEL: Record<FileDto['status'], string> = {
  pending: 'รอคิว',
  processing: 'กำลังเก็บ...',
  ready: 'พร้อมใช้',
  error: 'ผิดพลาด',
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fileIcon(mimeType: string): string {
  if (mimeType.startsWith('image/')) return '🖼️';
  if (mimeType === 'application/pdf') return '📄';
  if (mimeType.startsWith('video/')) return '🎬';
  if (mimeType.startsWith('audio/')) return '🎵';
  return '📎';
}

export interface FileCardProps {
  file: FileDto;
  folders: FolderDto[];
  tags: TagDto[];
  driveConnected?: boolean;
  onChanged: () => void;
}

export function FileCard({ file, folders, tags, driveConnected, onChanged }: FileCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileTags = tags.filter((t) => (file.tagIds ?? []).includes(t.id));

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

  return (
    <div className="file-card">
      {file.thumbnailUrl && (
        <img className="thumb" src={file.thumbnailUrl} alt={file.name} loading="lazy" />
      )}
      <div className="card-head">
        <span className={`status-badge ${file.status}`}>{STATUS_LABEL[file.status]}</span>
        <button
          className="icon-btn"
          aria-label="เมนูจัดการไฟล์"
          onClick={() => setMenuOpen((v) => !v)}
        >
          ⋯
        </button>
      </div>
      <div className="name">
        {!file.thumbnailUrl && `${fileIcon(file.mimeType)} `}
        {file.name}
      </div>
      {fileTags.length > 0 && (
        <div className="tag-row">
          {fileTags.map((t) => (
            <span key={t.id} className="tag-chip" style={{ background: t.color }}>
              {t.name}
            </span>
          ))}
        </div>
      )}
      <div className="meta">
        {formatSize(file.fileSize)} · {new Date(file.createdAt).toLocaleString('th-TH')}
      </div>
      {file.status === 'ready' && !menuOpen && (
        <a className="btn" href={downloadUrl(file.id)} target="_blank" rel="noreferrer">
          ดาวน์โหลด
        </a>
      )}
      {menuOpen && (
        <div className="card-menu">
          <button className="btn secondary" disabled={busy} onClick={handleRename}>
            เปลี่ยนชื่อ
          </button>
          <select
            className="select"
            disabled={busy}
            value={file.folderId ?? ''}
            onChange={(e) => handleMove(e.target.value)}
          >
            <option value="">📁 ไม่มีโฟลเดอร์</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                📁 {f.name}
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
          {driveConnected && file.status === 'ready' && (
            <button className="btn secondary" disabled={busy} onClick={handleExportDrive}>
              ⬆️ ส่งออก Google Drive
            </button>
          )}
          <button className="btn danger" disabled={busy} onClick={handleDelete}>
            ลบไฟล์
          </button>
        </div>
      )}
    </div>
  );
}
