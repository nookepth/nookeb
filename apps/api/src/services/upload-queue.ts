import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { BatchItem, LineSource, UploadBatchJob } from '@nookeb/shared';
import { config } from '../config';
import { buildProgressFlexMessage } from './flex.service';
import { pushMessage, replyMessage } from './line.service';

/**
 * Per-user debounce queue for normal uploads. A burst of image/file events from
 * one user is collected into a single batch (sliding 1500ms window); when it
 * fires we send ONE progress card and enqueue ONE `upload_batch` job for the
 * worker to process sequentially.
 *
 * Thread-safety: Node runs a single event loop, so Map reads/writes here are
 * never interleaved mid-operation, and each user has an independent entry — no
 * shared mutable state across concurrent users.
 *
 * Caveat: state is in-memory per API instance. Behind a multi-instance load
 * balancer, a user's events must hit the same instance to batch (fine for the
 * single-instance deploy; revisit with sticky routing / Redis if it scales out).
 */
const WINDOW_MS = 1500;

interface QueueEntry {
  timer: NodeJS.Timeout;
  items: BatchItem[];
  /** first event's replyToken — the only one we may reply with */
  replyToken: string | null;
  lineSource: LineSource;
  lineGroupId: string | null;
  username: string | null;
}

const queues = new Map<string, QueueEntry>();

/** True if a batch is already collecting for this user (skip a repeat profile fetch). */
export function hasPendingBatch(lineUserId: string): boolean {
  return queues.has(lineUserId);
}

// ── Per-user upload rate limiting (rolling 1-hour window) ────────────────────
//
// In-memory, per API instance (same caveat as the debounce queue above).
// Byte counts come from the size LINE declares in the webhook event — only
// `file` messages carry one, so image/video/audio count toward the file limit
// but contribute 0 bytes. The file-count limit is exact.

const HOUR_MS = 60 * 60 * 1000;

interface RateWindowEntry {
  timestamp: number;
  bytes: number;
}

interface RateWindow {
  entries: RateWindowEntry[];
  /** true once the "over limit" notice was sent for the current limit event */
  limitNotified: boolean;
}

const rateWindows = new Map<string, RateWindow>();

const RATE_LIMIT_TEXT =
  '⏳ คุณส่งไฟล์เกินขีดจำกัดชั่วโมงนี้แล้ว\n' +
  `อัพโหลดได้สูงสุด ${config.RATE_LIMIT_FILES_PER_HOUR} ไฟล์ หรือ ${Math.round(config.RATE_LIMIT_BYTES_PER_HOUR / (1024 * 1024 * 1024))} GB ต่อชั่วโมง\n` +
  'กรุณารอและลองใหม่อีกครั้ง';

function getWindow(lineUserId: string): RateWindow {
  let w = rateWindows.get(lineUserId);
  if (!w) {
    w = { entries: [], limitNotified: false };
    rateWindows.set(lineUserId, w);
  }
  // Drop entries older than 60 minutes (entries are appended in time order)
  const cutoff = Date.now() - HOUR_MS;
  while (w.entries.length > 0 && w.entries[0]!.timestamp < cutoff) w.entries.shift();
  return w;
}

export interface RateLimitStats {
  filesThisHour: number;
  bytesThisHour: number;
  filesRemaining: number;
  bytesRemaining: number;
}

/** Current rolling-window usage for a user (for dashboards/alerts). */
export function getRateLimitStats(lineUserId: string): RateLimitStats {
  const w = getWindow(lineUserId);
  const filesThisHour = w.entries.length;
  const bytesThisHour = w.entries.reduce((sum, e) => sum + e.bytes, 0);
  return {
    filesThisHour,
    bytesThisHour,
    filesRemaining: Math.max(0, config.RATE_LIMIT_FILES_PER_HOUR - filesThisHour),
    bytesRemaining: Math.max(0, config.RATE_LIMIT_BYTES_PER_HOUR - bytesThisHour),
  };
}

/**
 * Check-and-record: returns true (and records nothing) if accepting this file
 * would exceed either hourly limit; otherwise records it and re-arms the notice.
 */
function isRateLimited(lineUserId: string, incomingBytes: number): boolean {
  const w = getWindow(lineUserId);
  const files = w.entries.length;
  const bytes = w.entries.reduce((sum, e) => sum + e.bytes, 0);
  if (files >= config.RATE_LIMIT_FILES_PER_HOUR || bytes + incomingBytes > config.RATE_LIMIT_BYTES_PER_HOUR) {
    return true;
  }
  w.entries.push({ timestamp: Date.now(), bytes: incomingBytes });
  w.limitNotified = false; // back under the limit → future limit events notify again
  return false;
}

/** Send the over-limit notice at most once per user per rate-limit event. */
function notifyRateLimited(app: FastifyInstance, p: EnqueueParams): void {
  const w = rateWindows.get(p.lineUserId);
  if (!w || w.limitNotified) return;
  w.limitNotified = true;

  const message = { type: 'text' as const, text: RATE_LIMIT_TEXT };
  const target = p.lineGroupId ?? p.lineUserId;
  void (async () => {
    try {
      if (p.replyToken) await replyMessage(p.replyToken, [message]);
      else await pushMessage(target, [message]);
    } catch (err) {
      try {
        await pushMessage(target, [message]);
      } catch (pushErr) {
        app.log.error({ err, pushErr, lineUserId: p.lineUserId }, 'rate-limit notice send failed');
      }
    }
  })();
}

export interface EnqueueParams {
  lineUserId: string;
  item: BatchItem;
  replyToken: string | null;
  lineSource: LineSource;
  lineGroupId: string | null;
  username: string | null;
}

/** Add one upload to the user's batch, (re)starting the sliding debounce timer. */
export function enqueueUpload(app: FastifyInstance, p: EnqueueParams): void {
  // Rate limit gate — runs before anything is queued (and therefore before any
  // LINE CDN download). Over-limit files are skipped silently except for ONE
  // notice per limit event.
  if (isRateLimited(p.lineUserId, p.item.fileSize ?? 0)) {
    app.log.warn(
      { lineUserId: p.lineUserId, file: p.item.originalName },
      'upload rate limit exceeded — file skipped',
    );
    notifyRateLimited(app, p);
    return;
  }

  const existing = queues.get(p.lineUserId);
  if (existing) {
    existing.items.push(p.item);
    if (!existing.replyToken && p.replyToken) existing.replyToken = p.replyToken;
    if (!existing.username && p.username) existing.username = p.username;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => void flush(app, p.lineUserId), WINDOW_MS);
    return;
  }
  queues.set(p.lineUserId, {
    timer: setTimeout(() => void flush(app, p.lineUserId), WINDOW_MS),
    items: [p.item],
    replyToken: p.replyToken,
    lineSource: p.lineSource,
    lineGroupId: p.lineGroupId,
    username: p.username,
  });
}

async function flush(app: FastifyInstance, lineUserId: string): Promise<void> {
  const entry = queues.get(lineUserId);
  if (!entry) return;
  queues.delete(lineUserId);

  // 1. ONE progress card via the first replyToken. If it's expired/used (>60s or
  //    >1 use → 400), fall back to a push (to the group when in a group).
  const target = entry.lineGroupId ?? lineUserId;
  const batchId = randomUUID();
  const progress = buildProgressFlexMessage({
    total: entry.items.length,
    username: entry.username,
    // The progress page is served by the API, not the web app — hence APP_URL
    progressViewUrl: `${config.APP_URL}/progress/${batchId}/view`,
  });
  try {
    if (entry.replyToken) await replyMessage(entry.replyToken, [progress]);
    else await pushMessage(target, [progress]);
  } catch (err) {
    try {
      await pushMessage(target, [progress]);
    } catch (pushErr) {
      app.log.error({ err, pushErr }, 'progress card send failed');
    }
  }

  // 2. Hand the batch to the worker (uploads run there — project rule 1)
  const job: UploadBatchJob = {
    type: 'upload_batch',
    batchId,
    lineUserId,
    lineSource: entry.lineSource,
    lineGroupId: entry.lineGroupId,
    username: entry.username,
    items: entry.items,
  };
  try {
    const jobId = `batch-${lineUserId}-${Date.now()}`.replace(/[^a-zA-Z0-9-_]/g, '-');
    await app.fileQueue.add('upload_batch', job, { jobId });
  } catch (err) {
    app.log.error({ err }, 'failed to enqueue upload_batch');
  }
}
