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

// PUSH POLICY: push messages consume the monthly Messaging API quota and FAIL
// SILENTLY once it runs out; replies are free and always work. Reply with the
// event's token, or defer through pending-notify.service — see "LINE Messaging
// — Critical Rules" in CLAUDE.md. The ONE sanctioned exception is the ระบบตามงาน
// (Task Manager) feature: task announcements originate from a LIFF web submit
// and reminders from a BullMQ timer, so neither ever has a replyToken to spend.
// pushMessage below exists for THAT feature only — do not call it from any
// other flow (file uploads, scans, diary, referral, … all stay reply-only).

export class LinePushError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LinePushError';
  }
}

/**
 * Task-Manager-only push (see the policy note above). Throws LinePushError on
 * a non-2xx so the reminder job can retry with backoff (429 = LINE rate limit,
 * 5xx = transient) or record failed_at (4xx = permanent, e.g. quota exhausted
 * returns 429 with a monthly-limit message — the caller logs loudly either way
 * because a silent quota failure is this API's known trap).
 */
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
      throw new LinePushError(0, `LINE push timed out after ${LINE_MESSAGING_TIMEOUT_MS}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`[LINE-PUSH] failed status=${res.status} detail=${detail.slice(0, 300)}`);
    throw new LinePushError(res.status, `LINE push failed: ${res.status}`);
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

/** LINE chat ids encode their kind in the first character: C=group, R=room. */
function chatScope(chatId: string): 'group' | 'room' {
  return chatId.startsWith('R') ? 'room' : 'group';
}

/**
 * Group/room-scoped member profile. getProfile (/v2/bot/profile) only resolves
 * users who FRIENDED the OA — group members who never added the bot come back
 * 404 there, which is why rosters filled through it end up with NULL names.
 * This endpoint resolves any current member of a chat the bot is in, and 404s
 * for non-members (so a success doubles as a membership check). Falls back to
 * the friend profile; null means "couldn't resolve", never throws.
 */
export async function getChatMemberProfile(
  chatId: string,
  lineUserId: string,
): Promise<{ displayName: string; pictureUrl?: string } | null> {
  try {
    const res = await fetch(`${LINE_API}/${chatScope(chatId)}/${chatId}/member/${lineUserId}`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(LINE_MESSAGING_TIMEOUT_MS),
    });
    if (res.ok) return (await res.json()) as { displayName: string; pictureUrl?: string };
  } catch {
    // timeout/network — fall through to the friend profile
  }
  return getProfile(lineUserId).catch(() => null);
}

/**
 * Every member id of a group/room. LINE gates this endpoint to verified/
 * premium OAs — a 403 (or any failure) returns null and callers fall back to
 * the message-driven roster. Paginated via `start`; capped so a huge group
 * can't stall the request that awaits this.
 */
export async function getChatMemberIds(chatId: string, cap = 500): Promise<string[] | null> {
  const ids: string[] = [];
  let start: string | undefined;
  try {
    do {
      const url = new URL(`${LINE_API}/${chatScope(chatId)}/${chatId}/members/ids`);
      if (start) url.searchParams.set('start', start);
      const res = await fetch(url, {
        headers: authHeaders,
        signal: AbortSignal.timeout(LINE_MESSAGING_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { memberIds: string[]; next?: string };
      ids.push(...body.memberIds);
      start = body.next;
    } while (start && ids.length < cap);
  } catch {
    return null;
  }
  return ids.slice(0, cap);
}
