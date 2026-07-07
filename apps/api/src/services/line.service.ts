import { Readable } from 'node:stream';
import { config } from '../config';
import type { FlexMessage } from './flex.service';

const LINE_API = 'https://api.line.me/v2/bot';
const LINE_DATA_API = 'https://api-data.line.me/v2/bot';

// Outbound-call timeouts (AbortSignal.timeout, Node 18+). Messaging calls are
// quick JSON round-trips; the CDN content download can stream a large binary, so
// it gets a longer budget. Without these a hung LINE endpoint pins one of the
// worker's 5 concurrency slots forever — five stuck downloads freeze all file
// processing while users keep getting "รับแล้ว" replies.
const LINE_MESSAGING_TIMEOUT_MS = 10_000;
const LINE_CONTENT_TIMEOUT_MS = 30_000;

const authHeaders = {
  Authorization: `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}`,
};

/**
 * True for an AbortSignal.timeout() abort. fetch surfaces it as a DOMException
 * named 'TimeoutError' (name 'AbortError' on some runtimes / manual aborts).
 */
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

export interface LineContent {
  stream: Readable;
  contentType: string;
  contentLength: number | null;
}

/**
 * Download message binary from LINE CDN (content has ~1h TTL — worker must
 * run promptly after the webhook).
 */
export async function getMessageContent(messageId: string): Promise<LineContent> {
  let res: Response;
  try {
    res = await fetch(`${LINE_DATA_API}/message/${messageId}/content`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(LINE_CONTENT_TIMEOUT_MS),
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      // Throw so the file-bearing job fails and retries normally (LINE CDN
      // content has a ~1h TTL, so a re-download on retry still works).
      console.warn(`[LINE-TIMEOUT] content download timed out after ${LINE_CONTENT_TIMEOUT_MS}ms`);
      throw new Error(`LINE content download timed out after ${LINE_CONTENT_TIMEOUT_MS}ms`);
    }
    throw err;
  }
  if (!res.ok || !res.body) {
    throw new Error(`LINE content download failed: ${res.status} ${await res.text()}`);
  }
  const contentLength = res.headers.get('content-length');
  return {
    stream: Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    contentLength: contentLength ? Number(contentLength) : null,
  };
}

export interface TextMessage {
  type: 'text';
  text: string;
}

/** A plain LINE image message (both URLs must be permanent public HTTPS). */
export interface ImageMessage {
  type: 'image';
  originalContentUrl: string;
  previewImageUrl: string;
}

/** Any LINE message we send (text, image, or Flex). */
export type LineMessage = TextMessage | ImageMessage | FlexMessage;

export async function replyMessage(replyToken: string, messages: LineMessage[]): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${LINE_API}/message/reply`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ replyToken, messages }),
      signal: AbortSignal.timeout(LINE_MESSAGING_TIMEOUT_MS),
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      // Best-effort messaging: swallow the timeout so a slow LINE endpoint can
      // never crash the worker (the file is already stored + charged by now).
      console.warn(`[LINE-TIMEOUT] reply timed out after ${LINE_MESSAGING_TIMEOUT_MS}ms — continuing`);
      return;
    }
    throw err;
  }
  if (!res.ok) {
    console.error(`LINE API error: status=${res.status} call=reply`);
    throw new Error(`LINE reply failed: ${res.status}`);
  }
}

export async function pushMessage(to: string, messages: LineMessage[]): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${LINE_API}/message/push`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, messages }),
      signal: AbortSignal.timeout(LINE_MESSAGING_TIMEOUT_MS),
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      // Best-effort messaging: swallow the timeout so a slow LINE endpoint can
      // never crash the worker (the file is already stored + charged by now).
      console.warn(`[LINE-TIMEOUT] push timed out after ${LINE_MESSAGING_TIMEOUT_MS}ms — continuing`);
      return;
    }
    throw err;
  }
  if (!res.ok) {
    console.error(`LINE API error: status=${res.status} call=push`);
    throw new Error(`LINE push failed: ${res.status}`);
  }
}

export async function getProfile(lineUserId: string): Promise<{
  displayName: string;
  pictureUrl?: string;
}> {
  let res: Response;
  try {
    res = await fetch(`${LINE_API}/profile/${lineUserId}`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(LINE_MESSAGING_TIMEOUT_MS),
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      console.warn(`[LINE-TIMEOUT] profile fetch timed out after ${LINE_MESSAGING_TIMEOUT_MS}ms`);
      throw new Error(`LINE profile fetch timed out after ${LINE_MESSAGING_TIMEOUT_MS}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`LINE profile fetch failed: ${res.status}`);
  }
  return (await res.json()) as { displayName: string; pictureUrl?: string };
}
