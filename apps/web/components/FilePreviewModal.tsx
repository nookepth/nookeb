'use client';

import { useEffect, useState } from 'react';
import type { FileDto } from '@nookeb/shared';
import { getFile, startDownload } from '@/lib/api';
// FIX: download - the preview image must stay long-pressable on iOS (no onContextMenu preventDefault, no pointer-events:none, no -webkit-touch-callout:none anywhere on .preview-media)

function canInline(mimeType: string): boolean {
  return (
    mimeType.startsWith('image/') ||
    mimeType === 'application/pdf' ||
    mimeType.startsWith('text/')
  );
}

export interface FilePreviewModalProps {
  /** Files to preview, in display order. One file = plain preview, more = gallery with prev/next. */
  files: FileDto[];
  onClose: () => void;
}

export function FilePreviewModal({ files, onClose }: FilePreviewModalProps) {
  const [index, setIndex] = useState(0);
  // FIX: 2 - iOS Safari needs a long-press to save images (no programmatic download)
  const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);
  // fileId → presigned url (null = fetch failed / file not ready → download fallback)
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  const file = files[index];

  useEffect(() => {
    if (!file || file.id in urls || !canInline(file.mimeType)) return;
    let cancelled = false;
    getFile(file.id)
      .then((f) => {
        if (!cancelled) setUrls((prev) => ({ ...prev, [file.id]: f.url }));
      })
      .catch(() => {
        if (!cancelled) setUrls((prev) => ({ ...prev, [file.id]: null }));
      });
    return () => {
      cancelled = true;
    };
  }, [file, urls]);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(files.length - 1, i + 1));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [files.length, onClose]);

  if (!file) return null;

  const url = urls[file.id];
  const inline = canInline(file.mimeType);
  const loading = inline && !(file.id in urls);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preview-head">
          <span className="preview-name">{file.name}</span>
          {files.length > 1 && (
            <span className="preview-counter">
              {index + 1} / {files.length}
            </span>
          )}
          <button className="icon-btn preview-close" aria-label="ปิด" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="preview-body">
          {loading ? (
            <span className="preview-hint">กำลังโหลด...</span>
          ) : inline && url && file.mimeType.startsWith('image/') ? (
            // FIX: download - iOS: drop the navigator.share button (it silently fails in LINE after an await); show the image + a persistent long-press hint instead
            <div className="preview-image-wrap">
              <img className="preview-media" src={url} alt={file.name} />
              {isIOS && (
                // FIX: download - sticky hint pinned to the bottom of the scroll container so it's never cut off below the viewport
                <div
                  style={{
                    position: 'sticky',
                    bottom: 0,
                    width: '100%',
                    backgroundColor: '#f9fafb',
                    borderTop: '1px solid #e5e7eb',
                    padding: '10px 16px',
                    textAlign: 'center',
                    fontSize: '14px',
                    color: '#6b7280',
                    zIndex: 10,
                  }}
                >
                  กดค้างที่รูปภาพ แล้วเลือก บันทึกรูปภาพ เพื่อบันทึกลงเครื่อง
                </div>
              )}
            </div>
          ) : inline && url ? (
            <iframe className="preview-frame" src={url} title={file.name} />
          ) : (
            <div className="preview-fallback">
              <span className="preview-hint">ดูไฟล์ชนิดนี้ในหน้านี้ไม่ได้</span>
              <button className="btn" onClick={() => void startDownload(file.id)}>
                ดาวน์โหลดไฟล์
              </button>
            </div>
          )}
        </div>

        {files.length > 1 && (
          <div className="preview-nav">
            <button
              className="btn secondary"
              disabled={index === 0}
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
            >
              ก่อนหน้า
            </button>
            <button
              className="btn secondary"
              disabled={index === files.length - 1}
              onClick={() => setIndex((i) => Math.min(files.length - 1, i + 1))}
            >
              ถัดไป
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
