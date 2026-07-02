import { Readable } from 'node:stream';
import { config } from '../config';

const LINE_API = 'https://api.line.me/v2/bot';
const LINE_DATA_API = 'https://api-data.line.me/v2/bot';

const authHeaders = {
  Authorization: `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}`,
};

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

interface TextMessage {
  type: 'text';
  text: string;
}

export async function replyMessage(replyToken: string, messages: TextMessage[]): Promise<void> {
  const res = await fetch(`${LINE_API}/message/reply`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) {
    throw new Error(`LINE reply failed: ${res.status} ${await res.text()}`);
  }
}

export async function pushMessage(to: string, messages: TextMessage[]): Promise<void> {
  const res = await fetch(`${LINE_API}/message/push`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, messages }),
  });
  if (!res.ok) {
    throw new Error(`LINE push failed: ${res.status} ${await res.text()}`);
  }
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
