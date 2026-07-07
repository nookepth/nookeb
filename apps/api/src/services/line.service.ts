import { Readable } from 'node:stream';
import { config } from '../config';
import type { FlexMessage } from './flex.service';

const LINE_API = 'https://api.line.me/v2/bot';
const LINE_DATA_API = 'https://api-data.line.me/v2/bot';

const authHeaders = {
  Authorization: `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}`,
};

// [DEBUG] One-time startup check that the messaging-API token was actually read
// from the env (length only — never log the secret itself).
console.log('[LINE-CLIENT] token length:', config.LINE_CHANNEL_ACCESS_TOKEN?.length ?? 0);

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
  const res = await fetch(`${LINE_DATA_API}/message/${messageId}/content`, {
    headers: authHeaders,
  });
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
  const types = messages.map((m) => m.type).join(',');
  console.log(`[DEBUG-PUSH] target=reply(${replyToken.slice(0, 8)}…) type=${types}`);
  const res = await fetch(`${LINE_API}/message/reply`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.log(`[DEBUG-PUSH-ERROR] ${body} ${res.status}`);
    throw new Error(`LINE reply failed: ${res.status} ${body}`);
  }
  console.log('[DEBUG-PUSH-OK] sent successfully');
}

export async function pushMessage(to: string, messages: LineMessage[]): Promise<void> {
  const types = messages.map((m) => m.type).join(',');
  console.log(`[DEBUG-PUSH] target=${to} type=${types}`);
  const res = await fetch(`${LINE_API}/message/push`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, messages }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.log(`[DEBUG-PUSH-ERROR] ${body} ${res.status}`);
    throw new Error(`LINE push failed: ${res.status} ${body}`);
  }
  console.log('[DEBUG-PUSH-OK] sent successfully');
}

export async function getProfile(lineUserId: string): Promise<{
  displayName: string;
  pictureUrl?: string;
}> {
  const res = await fetch(`${LINE_API}/profile/${lineUserId}`, { headers: authHeaders });
  if (!res.ok) {
    throw new Error(`LINE profile fetch failed: ${res.status}`);
  }
  return (await res.json()) as { displayName: string; pictureUrl?: string };
}
