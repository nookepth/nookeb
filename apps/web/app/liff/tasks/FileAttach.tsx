'use client';

import { useRef, useState } from 'react';
import styles from './tasks.module.css';
import { IconClose } from './components';
import { MAX_TASK_FILES, MAX_TASK_FILE_BYTES, formatBytes } from '../../../lib/taskFiles';

/**
 * "+ แนบไฟล์" picker for the ระบบตามงาน LIFF flows (create + ส่งงานกลับ).
 *
 * Holds File objects only — it never uploads. Both call sites need the bytes to
 * travel AFTER something else succeeds (the task must exist before files can be
 * attached to it; a submission's files go with the submit call), so the parent
 * owns the upload and this stays a controlled input.
 *
 * No thumbnails/previews by design: an attachment list is scanned by name, and
 * decoding user-picked images in the LINE webview to draw 40px squares is a lot
 * of jank for no information.
 */

export interface FileAttachProps {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
  /** e.g. "กำลังอัปโหลด 2/3" — shown with an indeterminate-ish progress bar */
  progress?: { done: number; total: number } | null;
  label?: string;
}

export function FileAttach({
  files,
  onChange,
  disabled = false,
  progress = null,
  label = '+ แนบไฟล์',
}: FileAttachProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = (picked: FileList | null) => {
    if (!picked || picked.length === 0) return;
    const incoming = Array.from(picked);

    const tooBig = incoming.filter((f) => f.size > MAX_TASK_FILE_BYTES);
    const fitting = incoming.filter((f) => f.size <= MAX_TASK_FILE_BYTES);
    // Same name AND size = the user picked the same file twice; silently keep one.
    const existing = new Set(files.map((f) => `${f.name}:${f.size}`));
    const fresh = fitting.filter((f) => !existing.has(`${f.name}:${f.size}`));

    const room = MAX_TASK_FILES - files.length;
    const accepted = fresh.slice(0, Math.max(0, room));

    const problems: string[] = [];
    if (tooBig.length > 0) {
      problems.push(`ไฟล์ใหญ่เกิน ${formatBytes(MAX_TASK_FILE_BYTES)}: ${tooBig.map((f) => f.name).join(', ')}`);
    }
    if (fresh.length > accepted.length) {
      problems.push(`แนบได้สูงสุด ${MAX_TASK_FILES} ไฟล์น้า`);
    }
    setError(problems.length > 0 ? problems.join(' · ') : null);
    if (accepted.length > 0) onChange([...files, ...accepted]);

    // Reset the input so re-picking the SAME file fires another change event.
    if (inputRef.current) inputRef.current.value = '';
  };

  const remove = (index: number) => {
    setError(null);
    onChange(files.filter((_, i) => i !== index));
  };

  const uploading = progress !== null;

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => pick(e.target.files)}
        disabled={disabled || uploading}
      />

      {files.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
          {files.map((file, i) => (
            <div
              key={`${file.name}:${file.size}:${i}`}
              className={styles.card}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px' }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <p
                  style={{
                    margin: 0,
                    fontSize: 14,
                    color: '#333',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {file.name}
                </p>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: '#8c8c8c' }}>
                  {formatBytes(file.size)}
                </p>
              </div>
              <button
                type="button"
                aria-label={`ลบ ${file.name}`}
                onClick={() => remove(i)}
                disabled={disabled || uploading}
                style={{
                  border: 'none',
                  background: 'none',
                  color: '#b0b0b0',
                  cursor: 'pointer',
                  padding: 6,
                }}
              >
                <IconClose size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {uploading ? (
        <div>
          <p className={styles.typeSub} style={{ margin: '0 0 6px' }}>
            กำลังอัปโหลด {progress.done}/{progress.total} ไฟล์…
          </p>
          <div className={styles.progressTrack}>
            <div
              className={styles.progressFill}
              style={{
                width: `${progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%`,
              }}
            />
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={styles.addItemBtn}
          onClick={() => inputRef.current?.click()}
          disabled={disabled || files.length >= MAX_TASK_FILES}
        >
          {label}
        </button>
      )}

      {error && (
        <p style={{ margin: '8px 0 0', fontSize: 12, color: '#b91c1c' }}>{error}</p>
      )}
    </div>
  );
}
