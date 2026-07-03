import type { FastifyInstance } from 'fastify';
import type { BatchItem, LineSource, UploadBatchJob } from '@nookeb/shared';
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
  const progress = buildProgressFlexMessage({ total: entry.items.length, username: entry.username });
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
