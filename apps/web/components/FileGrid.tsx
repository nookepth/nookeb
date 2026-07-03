'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import type { FileDto, FolderDto, TagDto } from '@nookeb/shared';
import { deleteFile, moveFile } from '@/lib/api';
import { FileCard } from './FileCard';
import { FilePreviewModal } from './FilePreviewModal';

export interface FileGridProps {
  files: FileDto[];
  folders: FolderDto[];
  tags: TagDto[];
  driveConnected?: boolean;
  view?: 'grid' | 'list';
  onChanged: () => void;
}

export function FileGrid({ files, folders, tags, driveConnected, view = 'grid', onChanged }: FileGridProps) {
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Ids hidden optimistically after a bulk delete, until the server list refreshes.
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  // Snapshot of the selection taken when preview opens, so a list refresh doesn't close it.
  const [previewFiles, setPreviewFiles] = useState<FileDto[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

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

  async function handleBulkMove(folderId: string | null): Promise<void> {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBusy(true);
    setActionError(null);
    const results = await Promise.allSettled(ids.map((id) => moveFile(id, folderId)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    setBusy(false);
    setMoveOpen(false);
    if (failed > 0) setActionError(`ย้าย ${failed} ไฟล์ไม่สำเร็จ`);
    else setToast(`ย้าย ${ids.length} ไฟล์เรียบร้อยแล้ว`);
    setSelectedIds(new Set());
    onChanged();
  }

  function openSelectedPreview(): void {
    const selected = visibleFiles.filter((f) => selectedIds.has(f.id));
    if (selected.length === 0) return;
    setPreviewFiles(selected);
  }

  if (visibleFiles.length === 0 && !selectMode) {
    return (
      <div className="empty-state">
        <Image src="/logo.png" alt="" width={96} height={96} className="empty-art" />
        <p className="empty-title">ยังไม่มีไฟล์</p>
        <p>ส่งรูปหรือไฟล์หา LINE OA แล้วหนูจะเก็บให้เอง</p>
      </div>
    );
  }

  return (
    <>
      <div className="select-bar">
        {!selectMode ? (
          <button className="btn secondary small" onClick={() => setSelectMode(true)}>
            เลือกไฟล์
          </button>
        ) : (
          <>
            <button
              className="btn secondary small"
              onClick={selectAll}
              disabled={visibleFiles.length === 0}
            >
              เลือกทั้งหมด
            </button>
            {actionError && <span className="select-error">{actionError}</span>}
          </>
        )}
      </div>

      {selectMode && (
        <div className="select-actionbar" role="toolbar" aria-label="จัดการไฟล์ที่เลือก">
          <span className="pill-label">เลือก {count} ไฟล์</span>
          <button
            className="btn secondary"
            disabled={busy || count === 0}
            onClick={openSelectedPreview}
          >
            ดูไฟล์
          </button>
          <button
            className="btn secondary"
            disabled={busy || count === 0}
            onClick={() => setMoveOpen(true)}
          >
            ย้าย
          </button>
          <button
            className="btn danger"
            disabled={busy || count === 0}
            onClick={() => void handleBulkDelete()}
          >
            ลบ
          </button>
          <button className="btn ghost-muted" onClick={exitSelectMode}>
            ยกเลิก
          </button>
        </div>
      )}

      {moveOpen && (
        <div className="modal-overlay" onClick={() => setMoveOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">ย้าย {count} ไฟล์ไปที่...</h3>
            <div className="folder-list">
              <button
                className="folder-option"
                disabled={busy}
                onClick={() => void handleBulkMove(null)}
              >
                คลังหลัก (ไม่มีโฟลเดอร์)
              </button>
              {folders.map((f) => (
                <button
                  key={f.id}
                  className="folder-option"
                  disabled={busy}
                  onClick={() => void handleBulkMove(f.id)}
                >
                  {f.name}
                </button>
              ))}
            </div>
            <button className="btn ghost-muted" onClick={() => setMoveOpen(false)}>
              ยกเลิก
            </button>
          </div>
        </div>
      )}

      {previewFiles && (
        <FilePreviewModal files={previewFiles} onClose={() => setPreviewFiles(null)} />
      )}

      {toast && <div className="toast">{toast}</div>}

      {visibleFiles.length === 0 ? (
        <p className="empty-state">ยังไม่มีไฟล์</p>
      ) : (
        <div
          className={`${view === 'list' ? 'file-list' : 'file-grid'} ${selectMode ? 'with-actionbar' : ''}`}
        >
          {visibleFiles.map((file) => (
            <FileCard
              key={file.id}
              file={file}
              folders={folders}
              tags={tags}
              driveConnected={driveConnected}
              onChanged={onChanged}
              onPreview={(f) => setPreviewFiles([f])}
              view={view}
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
