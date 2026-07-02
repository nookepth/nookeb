import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { AddScanPageJob, LineSource, UploadFileJob } from '@nookeb/shared';
import { verifyLineSignature } from '../../middleware/line-verify';
import { getProfile, replyMessage } from '../../services/line.service';
import { ensureUserAndSpace } from '../../services/file.service';
import { ensureGroupSpace } from '../../services/space.service';
import {
  cancelSession,
  countPages,
  getActiveSession,
  setSessionStatus,
  startSession,
} from '../../services/scan.service';
import { config } from '../../config';

interface LineEventSource {
  type: 'user' | 'group' | 'room';
  userId?: string;
  groupId?: string;
  roomId?: string;
}

interface LineMessageEvent {
  type: string; // 'message' | 'join' | 'follow' | ...
  replyToken?: string;
  source: LineEventSource;
  message?: {
    id: string;
    type: string; // 'image' | 'file' | 'video' | 'audio' | 'text' | ...
    fileName?: string;
    text?: string;
  };
}

interface LineWebhookBody {
  destination: string;
  events: LineMessageEvent[];
}

const EXT_BY_MESSAGE_TYPE: Record<string, string> = {
  image: 'jpg',
  video: 'mp4',
  audio: 'm4a',
};

function timestampName(ext: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `LINE_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${ext}`;
}

function sanitizeJobId(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^a-zA-Z0-9-_]/g, '-')}`;
}

async function reply(event: LineMessageEvent, text: string): Promise<void> {
  if (event.replyToken) await replyMessage(event.replyToken, [{ type: 'text', text }]);
}

/** Lightweight lookup — does not create a user (used before we know we need one). */
async function findUserId(app: FastifyInstance, lineUserId: string): Promise<string | null> {
  const { data, error } = await app.supabase
    .from('users')
    .select('id')
    .eq('line_user_id', lineUserId)
    .maybeSingle();
  if (error) throw error;
  return (data?.id as string | undefined) ?? null;
}

const HELP_TEXT = `วิธีใช้หนูเก็บ 🐭
• ส่งรูป/ไฟล์มาในแชท หนูจะเก็บให้อัตโนมัติ
• พิมพ์ "สแกน" เพื่อรวมรูปหลายหน้าเป็น PDF (ส่งรูปทีละหน้า แล้วพิมพ์ "เสร็จ")
• เปิดคลังไฟล์ ค้นหา จัดโฟลเดอร์ได้ที่ ${config.WEB_URL}/dashboard`;

function isCmd(text: string, ...matches: string[]): boolean {
  const t = text.trim().toLowerCase();
  return matches.some((m) => t === m.toLowerCase());
}

async function handleTextCommand(
  app: FastifyInstance,
  event: LineMessageEvent,
  text: string,
): Promise<void> {
  const source = event.source;
  const lineUserId = source.userId!;

  // Start scan mode
  if (isCmd(text, 'สแกน', 'scan', '/scan')) {
    const profile = await getProfile(lineUserId).catch(() => undefined);
    const { user, space } = await ensureUserAndSpace(
      app.supabase,
      lineUserId,
      profile?.displayName,
      profile?.pictureUrl,
    );
    const target =
      source.type === 'group' && source.groupId
        ? await ensureGroupSpace(app.supabase, source.groupId, user)
        : space;
    await startSession(app.supabase, user.id, target.id);
    await reply(
      event,
      '📸 โหมดสแกนเปิดแล้ว\nส่งรูปมาทีละหน้าได้เลย เมื่อครบแล้วพิมพ์ "เสร็จ" เพื่อรวมเป็น PDF\n(พิมพ์ "ยกเลิก" เพื่อออกจากโหมดสแกน)',
    );
    return;
  }

  const userId = await findUserId(app, lineUserId);
  const session = userId ? await getActiveSession(app.supabase, userId) : null;

  // Finish scan → merge to PDF
  if (isCmd(text, 'เสร็จ', 'done', 'รวมไฟล์', 'finish')) {
    if (!session) {
      await reply(event, 'ยังไม่ได้เปิดโหมดสแกนนะ พิมพ์ "สแกน" ก่อน แล้วค่อยส่งรูป 🐭');
      return;
    }
    const pages = await countPages(app.supabase, session.id);
    if (pages === 0) {
      await cancelSession(app.supabase, session.id);
      await reply(event, 'ยังไม่มีหน้าให้รวมเลย ยกเลิกโหมดสแกนให้แล้วนะ');
      return;
    }
    await setSessionStatus(app.supabase, session.id, 'processing');
    await app.fileQueue.add(
      'finalize_scan',
      { type: 'finalize_scan', sessionId: session.id, lineUserId },
      { jobId: sanitizeJobId('scan-final', session.id) },
    );
    await reply(event, `กำลังรวม ${pages} หน้าเป็น PDF... เดี๋ยวส่งให้นะ 🐭`);
    return;
  }

  // Cancel scan
  if (isCmd(text, 'ยกเลิก', 'cancel')) {
    if (session) {
      await cancelSession(app.supabase, session.id);
      await reply(event, 'ยกเลิกโหมดสแกนแล้ว รูปที่ค้างไว้ไม่ถูกบันทึกนะ');
    } else {
      await reply(event, 'ตอนนี้ไม่ได้อยู่ในโหมดสแกนอยู่แล้ว 🐭');
    }
    return;
  }

  // Help / default
  if (isCmd(text, 'วิธีใช้', 'help', 'เมนู')) {
    await reply(event, HELP_TEXT);
    return;
  }
  // In a group, don't chatter on every message — only reply to commands
  if (source.type === 'user') {
    await reply(event, `ส่งรูปหรือไฟล์มาได้เลย เดี๋ยวหนูเก็บให้ 🐭\nเปิดคลังไฟล์ได้ที่ ${config.WEB_URL}`);
  }
}

async function handleEvent(app: FastifyInstance, event: LineMessageEvent): Promise<void> {
  // Bot added to a group → greet
  if (event.type === 'join' || event.type === 'follow') {
    await reply(
      event,
      'สวัสดีค่ะ หนูเก็บเองงง 🐭\nส่งรูปหรือไฟล์เข้ามาได้เลย หนูจะเก็บให้อัตโนมัติ\nพิมพ์ "วิธีใช้" เพื่อดูคำสั่งทั้งหมด',
    );
    return;
  }

  if (event.type !== 'message' || !event.message) return;
  const { message, source } = event;
  const lineUserId = source.userId;
  if (!lineUserId) return;

  if (message.type === 'text') {
    await handleTextCommand(app, event, message.text ?? '');
    return;
  }

  const supported =
    message.type === 'image' ||
    message.type === 'file' ||
    message.type === 'video' ||
    message.type === 'audio';
  if (!supported) return;

  // An image sent while a scan session is collecting becomes a scan page
  if (message.type === 'image') {
    const userId = await findUserId(app, lineUserId);
    const session = userId ? await getActiveSession(app.supabase, userId) : null;
    if (session) {
      const job: AddScanPageJob = {
        type: 'add_scan_page',
        sessionId: session.id,
        lineMessageId: message.id,
      };
      await app.fileQueue.add('add_scan_page', job, {
        jobId: sanitizeJobId('scan-page', message.id),
      });
      const pageNo = (await countPages(app.supabase, session.id)) + 1;
      await reply(event, `เพิ่มหน้าที่ ${pageNo} แล้ว 📄 (พิมพ์ "เสร็จ" เมื่อครบทุกหน้า)`);
      return;
    }
  }

  // Normal upload (worker routes group uploads to the shared group space)
  const originalName =
    message.type === 'file' && message.fileName
      ? message.fileName
      : timestampName(EXT_BY_MESSAGE_TYPE[message.type] ?? 'bin');

  const job: UploadFileJob = {
    type: 'upload_file',
    lineMessageId: message.id,
    lineUserId,
    lineSource: source.type as LineSource,
    lineGroupId: source.groupId ?? null,
    originalName,
    mimeType: null,
    replyToken: null,
  };

  await app.fileQueue.add('upload_file', job, { jobId: sanitizeJobId('upload', message.id) });

  const label = message.type === 'file' ? `ไฟล์ "${originalName}"` : 'รูป';
  await reply(event, `รับ${label}แล้ว กำลังเก็บ...`);
}

const lineWebhookRoutes: FastifyPluginAsync = async (app) => {
  // Rate limit — scoped to this encapsulated plugin, so it applies ONLY to the
  // webhook route (100 req/min per IP). Other routes are unaffected.
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded, retry later',
    }),
  });

  // Scoped raw-body parser: signature verification needs the exact bytes LINE sent
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.post('/webhook/line', async (request, reply) => {
    const rawBody = request.body as Buffer;
    const signature = request.headers['x-line-signature'];

    if (!verifyLineSignature(rawBody, typeof signature === 'string' ? signature : undefined)) {
      return reply.code(401).send({ error: 'Invalid signature' });
    }

    let body: LineWebhookBody;
    try {
      body = JSON.parse(rawBody.toString('utf-8')) as LineWebhookBody;
    } catch {
      return reply.code(400).send({ error: 'Invalid JSON' });
    }

    // Reply 200 within 1 second — process events after the response is sent
    setImmediate(() => {
      for (const event of body.events ?? []) {
        handleEvent(app, event).catch((err) => {
          app.log.error({ err, eventType: event.type }, 'LINE event handling failed');
        });
      }
    });

    return reply.code(200).send({ ok: true });
  });
};

export default lineWebhookRoutes;
