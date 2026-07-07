import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { BatchItem, LineSource, SessionKind, UploadBatchJob } from '@nookeb/shared';
import { config } from '../config';
import { buildMergeFlexMessage, buildProgressFlexMessage, buildScanFlexMessage } from './flex.service';
import { getGroupNotifySetting } from './group-settings.service';
import { replyMessage, type LineMessage } from './line.service';

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
  /** group/room id for the notify-toggle lookup (group-only for routing lives in lineGroupId) */
  notifyGroupId: string | null;
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
  // Reply-only (no paid push fallback). The rate-limit gate runs synchronously in
  // the webhook, so the event's token is fresh; if it's missing/expired we skip.
  void (async () => {
    try {
      if (p.replyToken) await replyMessage(p.replyToken, [message]);
      else app.log.warn({ lineUserId: p.lineUserId }, 'rate-limit notice skipped — no reply token');
    } catch (err) {
      app.log.error({ err, lineUserId: p.lineUserId }, 'rate-limit notice reply failed — skipping (no push fallback)');
    }
  })();
}

export interface EnqueueParams {
  lineUserId: string;
  item: BatchItem;
  replyToken: string | null;
  lineSource: LineSource;
  lineGroupId: string | null;
  notifyGroupId: string | null;
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
    notifyGroupId: p.notifyGroupId,
    username: p.username,
  });
}

// ── Per-user scan-page reply debounce ────────────────────────────────────────
//
// Images sent during a merge (ระบบรวมรูป) session each enqueue their own
// `add_scan_page` job, but we must NOT reply per image — that floods the chat
// with duplicate "เพิ่มไฟล์ …" cards. Instead we debounce the confirmation on
// the same sliding 1500ms window as uploads and send ONE card showing the total
// pages accumulated in the session. The count is tracked in-memory (seeded from
// the DB count at the start of a burst, then +1 per event) so it never depends
// on the async worker having persisted this burst's pages yet.

interface ScanReplyEntry {
  timer: NodeJS.Timeout;
  /** first event's replyToken — the only one we may reply with */
  replyToken: string | null;
  /** group id or user id — where a push fallback goes */
  target: string;
  /** running total of pages in the session (pre-burst count + events so far) */
  count: number;
  /** which feature owns the session — picks the scan vs merge per-page card */
  kind: SessionKind;
}

const scanReplyQueues = new Map<string, ScanReplyEntry>();

/**
 * Register one collected scan page for the debounced confirmation card.
 * @param p.basePageCount pages already in the session BEFORE this burst (only
 *        read when opening a new burst; ignored while one is in flight).
 */
export function enqueueScanPageReply(
  app: FastifyInstance,
  p: {
    lineUserId: string;
    replyToken: string | null;
    target: string;
    basePageCount: number;
    kind: SessionKind;
  },
): void {
  const existing = scanReplyQueues.get(p.lineUserId);
  if (existing) {
    existing.count += 1;
    if (!existing.replyToken && p.replyToken) existing.replyToken = p.replyToken;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => void flushScanReply(app, p.lineUserId), WINDOW_MS);
    return;
  }
  scanReplyQueues.set(p.lineUserId, {
    timer: setTimeout(() => void flushScanReply(app, p.lineUserId), WINDOW_MS),
    replyToken: p.replyToken,
    target: p.target,
    count: p.basePageCount + 1,
    kind: p.kind,
  });
}

async function flushScanReply(app: FastifyInstance, lineUserId: string): Promise<void> {
  const entry = scanReplyQueues.get(lineUserId);
  if (!entry) return;
  scanReplyQueues.delete(lineUserId);

  const card =
    entry.kind === 'scan'
      ? buildScanFlexMessage({ kind: 'page', count: entry.count })
      : buildMergeFlexMessage({ kind: 'page', count: entry.count });
  // Reply-only (no paid push fallback). Scan/merge is a personal-chat feature, so
  // the debounced first-event token is present and fresh (~1.5s) here; if it's
  // somehow gone we skip silently and log rather than push.
  try {
    if (entry.replyToken) await replyMessage(entry.replyToken, [card]);
    else app.log.warn({ target: entry.target }, `${entry.kind} page card skipped — no reply token`);
  } catch (err) {
    app.log.error({ err }, `${entry.kind} page card reply failed — skipping (no push fallback)`);
  }
}

async function flush(app: FastifyInstance, lineUserId: string): Promise<void> {
  const entry = queues.get(lineUserId);
  if (!entry) return;
  queues.delete(lineUserId);

  // 1. ONE "รอสักครู่น้า …" progress card as a REPLY (the first event's token is
  //    only ~1.5s old here, so it's fresh). This is now the ONLY confirmation for
  //    the whole upload — the worker no longer pushes a summary — so it's sent in
  //    GROUPS too (previously groups were skipped and got a worker push instead).
  //    Reply-only: if the token is somehow already gone we skip silently and log,
  //    never falling back to a paid push (project goal: eliminate push messages).
  //    Its "ดูล็อคเกอร์" button opens the live progress page, which flips to
  //    "เสร็จแล้ว" and redirects to the locker once the worker finishes the batch.
  const batchId = randomUUID();
  // Pre-existing rule: GROUP/ROOM chats stay quiet — a short PLAIN-TEXT reply
  // only, never the Flex card/button (the card is noisy in a shared group). Only
  // 1-on-1 chats get the reference progress card. Both are REPLIES (fresh token);
  // neither pushes. Previously groups got no reply here and a worker text push —
  // that push is gone, so the group acknowledgement now lives here as a reply.
  const isGroup = entry.lineSource === 'group' || entry.lineSource === 'room';
  // Per-group opt-out: a group can silence the "บันทึกแล้วน้า ✓" confirmation with
  // "หนูเก็บปิดแจ้งเตือน" (migration 021). Default ON, and getGroupNotifySetting fails
  // open, so a missing setting / DB error still notifies. 1-on-1 chats are unaffected.
  const shouldNotify = isGroup ? await getGroupNotifySetting(app.supabase, entry.notifyGroupId) : true;
  const message: LineMessage = isGroup
    ? { type: 'text', text: 'บันทึกแล้วน้า ✓' }
    : buildProgressFlexMessage({
        total: entry.items.length,
        username: entry.username,
        // The progress page is served by the API, not the web app — hence APP_URL
        progressViewUrl: `${config.APP_URL}/progress/${batchId}/view`,
      });
  // When notifications are OFF for this group, store silently — no reply at all.
  if (shouldNotify) {
    try {
      if (entry.replyToken) await replyMessage(entry.replyToken, [message]);
      else app.log.warn({ lineUserId }, 'upload confirmation skipped — no reply token');
    } catch (err) {
      app.log.error({ err, lineUserId }, 'upload confirmation reply failed — skipping (no push fallback)');
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
