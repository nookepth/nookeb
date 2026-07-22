'use client';

import { apiFetch } from './liff';

/**
 * Client helper for ระบบตามงาน attachments (migration 045).
 *
 * Upload is a plain multipart POST to the API — there is deliberately NO
 * presigned-PUT path. Sending the bytes through the API is what makes the size
 * cap and the storage-quota charge enforceable (a presigned PUT lands bytes the
 * API never sees, so both would be advisory), and it leaves nothing to orphan
 * when a page is closed mid-flow.
 *
 * These limits MIRROR the server's (routes/task-files.ts). They exist to fail
 * fast in the picker, not to enforce anything — the API re-checks every one.
 */

export const MAX_TASK_FILES = 5;
export const MAX_TASK_FILE_BYTES = 20 * 1024 * 1024;

export type TaskFileKind = 'brief' | 'submission';

export interface TaskFileDto {
  id: string;
  fileId: string;
  taskItemId: string | null;
  name: string;
  size: number;
  mimeType: string;
  kind: TaskFileKind;
  uploadedByLineUid: string;
  createdAt: string;
  url: string | null;
}

export interface UploadResult {
  files: TaskFileDto[];
  /** per-file failures the API reported instead of failing the whole batch */
  rejected: { name: string; reason: string }[];
}

const REJECT_REASONS: Record<string, string> = {
  too_large: `ใหญ่เกิน ${MAX_TASK_FILE_BYTES / 1024 / 1024} MB`,
  quota_exceeded: 'พื้นที่เก็บเต็มแล้ว',
  upload_failed: 'อัปโหลดไม่สำเร็จ',
};

export function describeRejection(r: { name: string; reason: string }): string {
  return `${r.name} — ${REJECT_REASONS[r.reason] ?? 'แนบไม่สำเร็จ'}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Upload files to a task. Sent ONE PER REQUEST rather than as a single 5-file
 * body: the LINE in-app webview drops slow uploads on flaky mobile data, and a
 * per-file request means a drop costs one file instead of the whole batch — and
 * gives the caller real progress to render. `onProgress` fires after each file.
 */
export async function uploadTaskFiles(
  taskId: string,
  files: File[],
  opts: {
    itemId?: string | null;
    kind?: TaskFileKind;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<UploadResult> {
  const uploaded: TaskFileDto[] = [];
  const rejected: { name: string; reason: string }[] = [];
  const query = new URLSearchParams();
  if (opts.itemId) query.set('itemId', opts.itemId);
  if (opts.kind) query.set('kind', opts.kind);
  const suffix = query.toString() ? `?${query}` : '';

  for (const [i, file] of files.entries()) {
    const form = new FormData();
    form.append('file', file, file.name);
    try {
      const res = await apiFetch(
        `/api-proxy/tasks/${encodeURIComponent(taskId)}/files${suffix}`,
        { method: 'POST', body: form },
      );
      if (!res.ok) {
        rejected.push({ name: file.name, reason: res.status === 409 ? 'quota_exceeded' : 'upload_failed' });
      } else {
        const body = (await res.json()) as UploadResult;
        uploaded.push(...body.files);
        rejected.push(...body.rejected);
      }
    } catch {
      rejected.push({ name: file.name, reason: 'upload_failed' });
    }
    opts.onProgress?.(i + 1, files.length);
  }

  return { files: uploaded, rejected };
}

export async function listTaskFiles(taskId: string): Promise<TaskFileDto[]> {
  const res = await apiFetch(`/api-proxy/tasks/${encodeURIComponent(taskId)}/files`);
  if (!res.ok) return [];
  const body = (await res.json()) as { files: TaskFileDto[] };
  return body.files;
}
