import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { AddScanPageJob, LineSource } from '@nookeb/shared';
import { verifyLineSignature } from '../../middleware/line-verify';
import { getProfile, replyMessage, type LineMessage } from '../../services/line.service';
import { buildMergeFlexMessage, type FlexMessage } from '../../services/flex.service';
import { ensureUserAndSpace } from '../../services/file.service';
import { bindLineGroup, getTeamByLineGroup, listUserTeams } from '../../services/team.service';
import { enqueueScanPageReply, enqueueUpload, hasPendingBatch } from '../../services/upload-queue';
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
    /** declared size in bytes — LINE sends this for 'file' messages only */
    fileSize?: number;
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

async function replyFlex(event: LineMessageEvent, message: FlexMessage): Promise<void> {
  if (event.replyToken) await replyMessage(event.replyToken, [message]);
}

/**
 * A LINE quick-reply button. A `uri` button opens a link; otherwise it sends
 * `text` (falling back to the label) back as a message when tapped.
 */
interface QuickReplyButton {
  label: string;
  text?: string;
  uri?: string;
}

/**
 * Reply with a text message carrying LINE quick-reply buttons. The `TextMessage`
 * type doesn't model `quickReply`, so we build the payload here and cast — the
 * shape matches the LINE Messaging API.
 */
async function replyWithQuickReply(
  event: LineMessageEvent,
  text: string,
  buttons: QuickReplyButton[],
): Promise<void> {
  if (!event.replyToken) return;
  const message = {
    type: 'text',
    text,
    quickReply: {
      items: buttons.map((b) => ({
        type: 'action',
        action: b.uri
          ? { type: 'uri', label: b.label, uri: b.uri }
          : { type: 'message', label: b.label, text: b.text ?? b.label },
      })),
    },
  } as unknown as LineMessage;
  await replyMessage(event.replyToken, [message]);
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
• พิมพ์ "รวมรูป" ถ้าอยากรวมรูปหลายหน้าเป็น PDF (ส่งรูปทีละหน้า แล้วพิมพ์ "เสร็จ" น้า)
• เปิดคลังไฟล์ ค้นหา จัดโฟลเดอร์ได้ที่ https://nookeb-web.vercel.app/dashboard เลยน้า`;

// Rich-menu "แนะนำตัว" cell → the bot's self-introduction (message action, since the
// webhook has no postback handler — rich-menu buttons send these trigger words as text).
const INTRO_TEXT = `สาวัดดีกั้บพี่ๆ ทุกคนน้า~ 📄✨
หนูชื่อ "หนูเก็บ" หนูเกิดมาจากเอกสารที่ใช้งานเสร็จแล้วก็ทิ้งเป็นขยะ หนูเลยตั้งใจจะเก็บกระดาษทั้งหมดให้เป็นไฟล์ เก็บรูป ให้พี่เป็นระเบียบเรียบร้อย ไม่ให้หล่นหาย ไม่ให้กระจัดกระจาย 📁💎

ถ้าวันไหนหนูเผลอทำอะไรผิดพลาดไป อย่าเพิ่งดุหนูน้า 🥺 หนูสัญญาว่าจะตั้งใจปรับปรุงให้เก่งขึ้นเรื่อยๆ เลยกั้บบ

📄 วิธีใช้หนูเก็บน้า
• ส่งรูป/ไฟล์มาในแชท หนูจะเก็บให้เองเลยน้า
• พิมพ์ "รวมรูป" ถ้าอยากรวมรูปหลายหน้าเป็น PDF (ส่งรูปทีละหน้า แล้วพิมพ์ "เสร็จ" น้า)
• เปิดคลังไฟล์ ค้นหา จัดโฟลเดอร์ได้ที่ https://nookeb-web.vercel.app/dashboard เลยน้า 📂

อยากให้เก็บ อยากให้ค้น หรืออยากรวมรูปเป็น PDF เรียกหนูได้ตลอดเลยน้า~ หนูพร้อมช่วยพี่เสมอเยยย 💙`;

// Rich-menu "ช่วยเหลือ" cell → under construction.
const SUPPORT_TEXT = 'กำลังอัพเดต 🔧';

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

  // Quick-function menu (rich-menu-free shortcut). Shows the common actions as
  // LINE quick-reply buttons — the last one only makes sense inside a group.
  if (isCmd(text, 'หนูเก็บ', 'menu', 'เมนู')) {
    const buttons: QuickReplyButton[] = [{ label: 'ล็อคเกอร์', text: 'ล็อคเกอร์' }];
    // รวมรูป is personal-chat only, so it's not offered in a group menu.
    if (source.type !== 'group') {
      buttons.push({ label: 'รวมรูป', text: 'รวมรูป' });
    }
    buttons.push({ label: 'วิธีใช้', text: 'วิธีใช้' });
    if (source.type === 'group') {
      buttons.push({ label: 'ไอดีกลุ่ม', text: 'ไอดีกลุ่ม' });
      buttons.push({ label: 'ผูกทีม', text: 'ผูกทีม' });
    }
    await replyWithQuickReply(event, 'เลือกได้เลยน้า ', buttons);
    return;
  }

  // "ล็อคเกอร์" → quick-reply shortcuts (buttons only, no Flex card) in ALL
  // sources (group AND 1-on-1).
  if (isCmd(text, 'ล็อคเกอร์', 'locker')) {
    await replyWithQuickReply(event, 'ล็อคเกอร์ทีมน้า เลือกได้เลย', [
      { label: 'ดูล็อคเกอร์', uri: `${config.WEB_URL}/dashboard` },
      { label: 'อัพโหลดไฟล์', text: 'อัพโหลดไฟล์' },
    ]);
    return;
  }

  // Upload helper (the "อัพโหลดไฟล์" quick-reply button) — uploads happen by
  // sending files straight into the chat, so just nudge the user to do that.
  if (isCmd(text, 'อัพโหลดไฟล์', 'upload')) {
    await reply(event, 'ส่งรูปหรือไฟล์เข้ามาในแชทนี้ได้เลยน้า เดี๋ยวหนูเก็บให้เองน้า');
    return;
  }

  // Bind this LINE group to the sender's team (group context only). Auto-binds
  // when unambiguous (one team); with several teams the user picks by number
  // ("ผูกทีม 2"). Match the "ผูกทีม"/"bind team" prefix, then parse the rest as
  // an optional 1-based index.
  const bindMatch = /^(?:ผูกทีม|bind team)\s*(\d+)?$/i.exec(text.trim());
  if (bindMatch) {
    if (source.type !== 'group' || !source.groupId) {
      await reply(event, 'ใช้คำสั่งนี้ในกลุ่มเท่านั้นน้า');
      return;
    }
    const groupId = source.groupId;
    const pick = bindMatch[1] ? Number(bindMatch[1]) : null; // 1-based, or null

    const existing = await getTeamByLineGroup(app.supabase, groupId);
    if (existing) {
      await reply(event, `กลุ่มนี้ผูกกับทีม ${existing.name} อยู่แล้วน้า`);
      return;
    }

    const userId = await findUserId(app, lineUserId);
    const teams = userId ? await listUserTeams(app.supabase, userId) : [];

    if (teams.length === 0 || !userId) {
      await reply(event, 'ยังไม่มีทีมน้า ไปสร้างทีมที่แดชบอร์ดก่อนน้า');
      return;
    }

    // Explicit pick ("ผูกทีม 2") — bind that team regardless of team count.
    if (pick !== null) {
      const chosen = teams[pick - 1];
      if (!chosen) {
        await reply(event, `ไม่มีทีมที่ ${pick} น้า ลองใหม่อีกทีน้า`);
        return;
      }
      await bindLineGroup(app.supabase, chosen.team.id, groupId, userId);
      await reply(event, `ผูกกลุ่มกับทีม ${chosen.team.name} เรียบร้อยแล้วน้า ✓`);
      return;
    }

    if (teams.length === 1 && teams[0]) {
      // Unambiguous → auto-bind.
      const only = teams[0];
      await bindLineGroup(app.supabase, only.team.id, groupId, userId);
      await reply(
        event,
        `ผูกกลุ่มกับทีม ${only.team.name} แล้วน้า\nส่งไฟล์ในกลุ่มนี้จะเข้าพื้นที่ทีมเลย ✓`,
      );
      return;
    }
    // More than one team → list them numbered; the user re-sends "ผูกทีม [เลข]".
    const teamList = teams.map((t, i) => `${i + 1}. ${t.team.name}`).join('\n');
    await reply(event, `มีหลายทีมน้า พิมพ์ ผูกทีม [เลข] เพื่อเลือกได้เลย:\n${teamList}`);
    return;
  }

  // Show this group's LINE Group ID (for binding it to a team in the dashboard)
  if (isCmd(text, 'ไอดีกลุ่ม', 'group id', 'groupid')) {
    if (source.type !== 'group' || !source.groupId) {
      await reply(event, 'คำสั่งนี้ใช้ได้ในกลุ่มเท่านั้นน้า');
      return;
    }
    const groupId = source.groupId;
    const team = await getTeamByLineGroup(app.supabase, groupId);
    if (team) {
      await reply(event, `ไอดีกลุ่มนี้คือ:\n${groupId}\n\nผูกกับทีม: ${team.name} แล้วน้า`);
    } else {
      await reply(
        event,
        `ไอดีกลุ่มนี้คือ:\n${groupId}\n\nยังไม่ได้ผูกกับทีมไหนน้า เอาไอดีนี้ไปใส่ในแดชบอร์ด → ทีม → ผูกกลุ่ม ได้เลยน้า`,
      );
    }
    return;
  }

  // Start merge-to-PDF mode (also triggered by the rich-menu "รวมรูปเป็น PDF" cell;
  // "สแกน"/"scan" kept as legacy aliases — the old rich menu still sends them)
  if (isCmd(text, 'รวมรูป', 'สแกน', 'scan', '/scan', 'รวมรูปเป็น pdf')) {
    // Merge-to-PDF is a personal-chat feature only — group scan sessions would
    // collide across members sharing one group space.
    if (source.type === 'group' || source.type === 'room') {
      await reply(event, 'ระบบรวมรูปใช้ได้เฉพาะแชทส่วนตัวน้า');
      return;
    }
    const profile = await getProfile(lineUserId).catch(() => undefined);
    const { user, space } = await ensureUserAndSpace(
      app.supabase,
      lineUserId,
      profile?.displayName,
      profile?.pictureUrl,
    );
    // Merge is personal-only (group/room returned above), so always the personal space.
    await startSession(app.supabase, user.id, space.id);
    await replyFlex(event, buildMergeFlexMessage({ kind: 'opened' }));
    return;
  }

  const userId = await findUserId(app, lineUserId);
  const session = userId ? await getActiveSession(app.supabase, userId) : null;

  // Finish merge → build the PDF ("รวมรูป" moved to the start triggers above)
  if (isCmd(text, 'เสร็จ', 'done', 'finish')) {
    if (!session) {
      await reply(event, 'ยังไม่ได้เปิดโหมดรวมรูปเลยน้า พิมพ์ "รวมรูป" ก่อน แล้วค่อยส่งรูปน้า');
      return;
    }
    const pages = await countPages(app.supabase, session.id);
    if (pages === 0) {
      await cancelSession(app.supabase, session.id);
      await reply(event, 'ยังไม่มีไฟล์ให้รวมเลยน้า หนูยกเลิกโหมดรวมรูปให้แล้วนะคะ');
      return;
    }
    await setSessionStatus(app.supabase, session.id, 'processing');
    await app.fileQueue.add(
      'finalize_scan',
      { type: 'finalize_scan', sessionId: session.id, lineUserId },
      { jobId: sanitizeJobId('scan-final', session.id), ...RETRY_OPTS },
    );
    await reply(event, `หนูกำลังรวม ${pages} ไฟล์เป็น PDF อยู่น้า เดี๋ยวส่งให้เลยน้า`);
    return;
  }

  // Cancel merge session
  if (isCmd(text, 'ยกเลิก', 'cancel')) {
    if (session) {
      await cancelSession(app.supabase, session.id);
      await reply(event, 'ยกเลิกโหมดรวมรูปให้แล้วน้า รูปที่ค้างไว้หนูไม่ได้เก็บนะคะ');
    } else {
      await reply(event, 'ตอนนี้ไม่ได้อยู่ในโหมดรวมรูปอยู่แล้วน้า');
    }
    return;
  }

  // Self-introduction (rich-menu "แนะนำตัว" cell; "หนูเก็บ" now opens the menu)
  if (isCmd(text, 'แนะนำตัว')) {
    await reply(event, INTRO_TEXT);
    return;
  }

  // Support (rich-menu "ช่วยเหลือ" cell)
  if (isCmd(text, 'ช่วยเหลือ', 'support')) {
    await reply(event, SUPPORT_TEXT);
    return;
  }

  // Scan-to-PDF (rich-menu "สแกนรูปเป็น PDF" cell) — under construction
  if (isCmd(text, 'สแกนรูปเป็น pdf')) {
    await reply(event, 'กำลังอัพเดต 🔧');
    return;
  }

  // How-to / usage guide (rich-menu "วิธีใช้งาน" cell; "เมนู" now opens the menu)
  if (isCmd(text, 'วิธีใช้', 'วิธีใช้งาน', 'help')) {
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
      // One confirmation per burst, not per image: debounce the reply and show the
      // accumulated session total. `basePageCount` is the count BEFORE this burst;
      // only the first event of a burst uses it (see enqueueScanPageReply).
      const basePageCount = await countPages(app.supabase, session.id);
      enqueueScanPageReply(app, {
        lineUserId,
        replyToken: event.replyToken ?? null,
        target: source.groupId ?? lineUserId,
        basePageCount,
      });
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
    item: {
      lineMessageId: message.id,
      originalName,
      kind: message.type,
      fileSize: message.fileSize ?? null,
    },
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
