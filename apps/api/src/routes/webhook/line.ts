import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { AddScanPageJob, LineSource } from '@nookeb/shared';
import { verifyLineSignature } from '../../middleware/line-verify';
import { getProfile, replyMessage } from '../../services/line.service';
import { ensureUserAndSpace } from '../../services/file.service';
import { ensureGroupSpace } from '../../services/space.service';
import { enqueueUpload, hasPendingBatch } from '../../services/upload-queue';
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

// LINE CDN content has a ~1h TTL and the user has already been told "รับแล้ว",
// so the file-bearing jobs MUST survive transient failures. Retry with backoff.
// (The worker's handlers are written to be safe to re-run — see upload.worker.ts.)
const RETRY_OPTS = { attempts: 3, backoff: { type: 'exponential', delay: 5000 } } as const;

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

const HELP_TEXT = `วิธีใช้หนูเก็บน้า
• ส่งรูป/ไฟล์มาในแชท หนูจะเก็บให้เองเลยน้า
• พิมพ์ "สแกน" ถ้าอยากรวมรูปหลายหน้าเป็น PDF (ส่งรูปทีละหน้า แล้วพิมพ์ "เสร็จ" น้า)
• เปิดคลังไฟล์ ค้นหา จัดโฟลเดอร์ได้ที่ ${config.WEB_URL}/dashboard เลยน้า`;

// Rich-menu "แนะนำตัว" cell → the bot's self-introduction (message action, since the
// webhook has no postback handler — rich-menu buttons send these trigger words as text).
const INTRO_TEXT = `สวัสดีกั้บบ พี่ๆ ทุกคน~ 🦈✨
หนูชื่อ "หนูเก็บ" หนูเป็นน้องฉลามตัวน้อยที่ชอบเก็บของที่สุดเลย! หน้าที่ของหนูคือคอยเก็บไฟล์ เก็บรูป ให้พี่เป็นระเบียบเรียบร้อย ไม่ให้หล่นหาย ไม่ให้กระจัดกระจาย 📁💎
ถ้าวันไหนหนูเผลอทำอะไรผิดพลาดไป อย่าเพิ่งดุหนูน้า🥺 หนูสัญญาว่าจะตั้งใจปรับปรุงให้เก่งขึ้นเรื่อยๆ เลยกั้บบ
อยากให้เก็บ อยากให้ค้น หรืออยากรวมรูปเป็น PDF สวยๆ เรียกหนูได้ตลอดเลยน้า~ หนูพร้อมช่วยพี่เสมอเยยย💙`;

// Rich-menu "ช่วยเหลือ" cell → support/troubleshooting (distinct from "วิธีใช้งาน" → HELP_TEXT).
const SUPPORT_TEXT = `หนูอยู่ตรงนี้น้า ถ้าต้องการความช่วยเหลือ 💙
• ส่งรูป/ไฟล์แล้วหนูยังไม่ตอบ ลองส่งใหม่อีกครั้งน้า
• อยากรวม/สแกนรูปเป็น PDF พิมพ์ "สแกน" แล้วส่งรูปทีละหน้า ครบแล้วพิมพ์ "เสร็จ" น้า
• อยากดูวิธีใช้ทั้งหมด กดปุ่ม "วิธีใช้งาน" หรือพิมพ์ "วิธีใช้" ได้เลยน้า
• เปิดคลังไฟล์ ค้นหา จัดโฟลเดอร์ที่ ${config.WEB_URL}/dashboard น้า`;

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

  // Start scan mode (also triggered by the rich-menu "รวมรูปเป็น PDF" / "สแกนรูปเป็น PDF" cells)
  if (isCmd(text, 'สแกน', 'scan', '/scan', 'รวมรูปเป็น pdf', 'สแกนรูปเป็น pdf')) {
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
      'เปิดโหมดสแกนแล้วน้า\nส่งรูปมาทีละหน้าได้เลยน้า ครบแล้วพิมพ์ "เสร็จ" หนูจะรวมเป็น PDF ให้\n(พิมพ์ "ยกเลิก" ถ้าไม่เอาแล้วน้า)',
    );
    return;
  }

  const userId = await findUserId(app, lineUserId);
  const session = userId ? await getActiveSession(app.supabase, userId) : null;

  // Finish scan → merge to PDF
  if (isCmd(text, 'เสร็จ', 'done', 'รวมไฟล์', 'finish')) {
    if (!session) {
      await reply(event, 'ยังไม่ได้เปิดโหมดสแกนเลยน้า พิมพ์ "สแกน" ก่อน แล้วค่อยส่งรูปน้า');
      return;
    }
    const pages = await countPages(app.supabase, session.id);
    if (pages === 0) {
      await cancelSession(app.supabase, session.id);
      await reply(event, 'ยังไม่มีหน้าให้รวมเลยน้า หนูยกเลิกโหมดสแกนให้แล้วนะคะ');
      return;
    }
    await setSessionStatus(app.supabase, session.id, 'processing');
    await app.fileQueue.add(
      'finalize_scan',
      { type: 'finalize_scan', sessionId: session.id, lineUserId },
      { jobId: sanitizeJobId('scan-final', session.id), ...RETRY_OPTS },
    );
    await reply(event, `หนูกำลังรวม ${pages} หน้าเป็น PDF อยู่น้า เดี๋ยวส่งให้เลยน้า`);
    return;
  }

  // Cancel scan
  if (isCmd(text, 'ยกเลิก', 'cancel')) {
    if (session) {
      await cancelSession(app.supabase, session.id);
      await reply(event, 'ยกเลิกโหมดสแกนให้แล้วน้า รูปที่ค้างไว้หนูไม่ได้เก็บนะคะ');
    } else {
      await reply(event, 'ตอนนี้ไม่ได้อยู่ในโหมดสแกนอยู่แล้วน้า');
    }
    return;
  }

  // Self-introduction (rich-menu "แนะนำตัว" cell)
  if (isCmd(text, 'แนะนำตัว', 'หนูเก็บ')) {
    await reply(event, INTRO_TEXT);
    return;
  }

  // Support (rich-menu "ช่วยเหลือ" cell)
  if (isCmd(text, 'ช่วยเหลือ', 'support')) {
    await reply(event, SUPPORT_TEXT);
    return;
  }

  // How-to / usage guide (rich-menu "วิธีใช้งาน" cell)
  if (isCmd(text, 'วิธีใช้', 'วิธีใช้งาน', 'help', 'เมนู')) {
    await reply(event, HELP_TEXT);
    return;
  }
  // In a group, don't chatter on every message — only reply to commands
  if (source.type === 'user') {
    await reply(event, `ส่งรูปหรือไฟล์มาได้เลยน้า เดี๋ยวหนูเก็บให้เอง\nเปิดคลังไฟล์ได้ที่ ${config.WEB_URL} น้า`);
  }
}

async function handleEvent(app: FastifyInstance, event: LineMessageEvent): Promise<void> {
  // Bot added to a group → greet
  if (event.type === 'join' || event.type === 'follow') {
    await reply(
      event,
      'สวัสดีค้าบ หนูเก็บเองน้า\nส่งรูปหรือไฟล์เข้ามาได้เลย หนูจะเก็บให้เองเลยน้า\nพิมพ์ "วิธีใช้" ถ้าอยากดูคำสั่งทั้งหมดน้า',
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
        ...RETRY_OPTS,
      });
      const pageNo = (await countPages(app.supabase, session.id)) + 1;
      await reply(event, `เพิ่มหน้าที่ ${pageNo} แล้วน้า (ครบทุกหน้าแล้วพิมพ์ "เสร็จ" ได้เลยน้า)`);
      return;
    }
  }

  // Normal upload → per-user debounce batch. No per-file reply here: the queue
  // sends ONE progress card when the window closes, and the worker sends ONE
  // summary card when the batch finishes (worker routes group uploads to the
  // shared group space).
  const originalName =
    message.type === 'file' && message.fileName
      ? message.fileName
      : timestampName(EXT_BY_MESSAGE_TYPE[message.type] ?? 'bin');

  // Resolve the display name once per batch (only when starting a new one)
  let username: string | null = null;
  if (!hasPendingBatch(lineUserId)) {
    const profile = await getProfile(lineUserId).catch(() => undefined);
    username = profile?.displayName ?? null;
  }

  enqueueUpload(app, {
    lineUserId,
    item: { lineMessageId: message.id, originalName, kind: message.type },
    replyToken: event.replyToken ?? null,
    lineSource: source.type as LineSource,
    lineGroupId: source.groupId ?? null,
    username,
  });
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
