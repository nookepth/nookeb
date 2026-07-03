'use client';

import { useEffect, useState } from 'react';
import type { FileDto, FolderDto, TagDto } from '@nookeb/shared';
import { deleteFile, downloadUrl } from '@/lib/api';
import { FileCard } from './FileCard';

export interface FileGridProps {
  files: FileDto[];
  folders: FolderDto[];
  tags: TagDto[];
  driveConnected?: boolean;
  onChanged: () => void;
}

export function FileGrid({ files, folders, tags, driveConnected, onChanged }: FileGridProps) {
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Ids hidden optimistically after a bulk delete, until the server list refreshes.
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // A fresh list from the server clears optimistic removals + stale selections.
  useEffect(() => {
    setRemovedIds(new Set());
    setSelectedIds(new Set());
  }, [files]);

  const visibleFiles = files.filter((f) => !removedIds.has(f.id));
  const count = selectedIds.size;

  function exitSelectMode(): void {
    setSelectMode(false);
    setSelectedIds(new Set());
    setActionError(null);
  }

  function toggleSelect(id: string): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll(): void {
    setSelectedIds(new Set(visibleFiles.map((f) => f.id)));
  }

  async function handleBulkDelete(): Promise<void> {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!window.confirm(`ต้องการลบ ${ids.length} ไฟล์ใช่ไหม?`)) return;
    setBusy(true);
    setActionError(null);
    // Optimistic: hide the selected cards right away.
    setRemovedIds((prev) => new Set([...prev, ...ids]));
    const results = await Promise.allSettled(ids.map((id) => deleteFile(id)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) setActionError(`ลบ ${failed} ไฟล์ไม่สำเร็จ`);
    setSelectedIds(new Set());
    setBusy(false);
    // Revalidate — restores any that actually failed and resets removedIds.
    onChanged();
  }

  function handleBulkDownload(): void {
    for (const id of selectedIds) {
      const a = document.createElement('a');
      a.href = downloadUrl(id);
      a.target = '_blank';
      a.rel = 'noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }

  if (visibleFiles.length === 0 && !selectMode) {
    return (
      <div className="empty-state">
        <p>ยังไม่มีไฟล์เลย</p>
        <p>ส่งรูปหรือไฟล์หา LINE OA แล้วหนูจะเก็บให้เอง</p>
      </div>
    );
  }

  return (
    <>
      <div className="select-bar">
        {!selectMode ? (
          <button className="btn secondary" onClick={() => setSelectMode(true)}>
            เลือกไฟล์
          </button>
        ) : (
          <>
            <button className="btn secondary" onClick={exitSelectMode}>
              ยกเลิก
            </button>
            <button
              className="btn secondary"
              onClick={selectAll}
              disabled={visibleFiles.length === 0}
            >
              เลือกทั้งหมด
            </button>
            {count > 0 && <span className="select-count">เลือกแล้ว {count} ไฟล์</span>}
          </>
        )}
      </div>

      {selectMode && (
        <div className="select-actionbar">
          <button
            className="btn danger"
            disabled={busy || count === 0}
            onClick={() => void handleBulkDelete()}
          >
            ลบ
          </button>
          <button
            className="btn secondary"
            disabled={busy || count === 0}
            onClick={handleBulkDownload}
          >
            ดาวน์โหลด
          </button>
          {actionError && <span className="select-error">{actionError}</span>}
        </div>
      )}

      {visibleFiles.length === 0 ? (
        <p className="empty-state">ยังไม่มีไฟล์เลย</p>
      ) : (
        <div className="file-grid">
          {visibleFiles.map((file) => (
            <FileCard
              key={file.id}
              file={file}
              folders={folders}
              tags={tags}
              driveConnected={driveConnected}
              onChanged={onChanged}
              selectMode={selectMode}
              selected={selectedIds.has(file.id)}
              onToggleSelect={toggleSelect}
            />
          ))}
        </div>
      )}
    </>
  );
}
