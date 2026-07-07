import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { AddScanPageJob, LineSource, ScanMode } from '@nookeb/shared';
import { verifyLineSignature } from '../../middleware/line-verify';
import { getProfile, replyMessage, type LineMessage } from '../../services/line.service';
import {
  buildInviteFlexMessage,
  buildMergeFlexMessage,
  buildOnboardingCarouselMessage,
  buildScanFlexMessage,
  buildTeamGuideFlexMessage,
  type FlexMessage,
} from '../../services/flex.service';
import { ensureUserAndSpace } from '../../services/file.service';
import {
  checkRedeemRateLimit,
  getReferralStatus,
  redeemCode,
  type RedeemFailCode,
} from '../../services/referral.service';
import {
  sendRedeemSuccessToReferee,
  sendReferralProgressToReferrer,
} from '../../services/referral.messages';
import {
  bindLineGroup,
  getTeamByLineGroup,
  getTeamRole,
  listUserTeams,
  unbindLineGroup,
} from '../../services/team.service';
import { enqueueScanPageReply, enqueueUpload, hasPendingBatch } from '../../services/upload-queue';
import {
  cancelSession,
  countPages,
  getActiveSession,
  setSessionMode,
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
  type: string; // 'message' | 'join' | 'follow' | 'postback' | ...
  replyToken?: string;
  source: LineEventSource;
  /** Present on 'postback' events — the tapped action's `data` string. */
  postback?: { data: string };
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

/**
 * Onboarding sent on `follow` (1-1 chat) and `join` (group/room): a plain welcome
 * image + a 7-bubble scrollable carousel Flex message (builder in flex.service.ts).
 * Two messages fit LINE's 5-per-reply limit, so no push/split is needed. The
 * carousel's per-bubble postback taps are routed by the postback handler in
 * handleEvent.
 */
async function sendOnboarding(event: LineMessageEvent): Promise<void> {
  if (!event.replyToken) return;
  await replyMessage(event.replyToken, [
    {
      type: 'image',
      originalContentUrl: `${config.APP_URL}/static/welcome.jpg`,
      previewImageUrl: `${config.APP_URL}/static/welcome.jpg`,
    },
    buildOnboardingCarouselMessage(),
  ]);
}

async function reply(event: LineMessageEvent, text: string): Promise<void> {
  if (event.replyToken) await replyMessage(event.replyToken, [{ type: 'text', text }]);
}

async function replyFlex(event: LineMessageEvent, message: FlexMessage): Promise<void> {
  if (event.replyToken) await replyMessage(event.replyToken, [message]);
}

/**
 * Reply with a Flex message carrying LINE quick-reply buttons. `FlexMessage`
 * doesn't model `quickReply`, so we attach it here and cast — the shape matches
 * the LINE Messaging API (same pattern as {@link replyWithQuickReply}).
 */
/**
 * Build a quick-reply action for a button. LINE rejects the WHOLE message (400)
 * if a `uri` action isn't https — so a non-https uri (http localhost in dev, or a
 * misconfigured WEB_URL) would make the entire card fail to render. Fall back to a
 * `message` action carrying the URL so the reply always succeeds (mirrors the
 * `startsWith('https://')` guard the Flex builders already use).
 */
function quickReplyAction(b: QuickReplyButton): Record<string, unknown> {
  if (b.uri && b.uri.startsWith('https://')) {
    return { type: 'action', action: { type: 'uri', label: b.label, uri: b.uri } };
  }
  const text = b.uri ?? b.text ?? b.label;
  return { type: 'action', action: { type: 'message', label: b.label, text } };
}

async function replyFlexWithQuickReply(
  event: LineMessageEvent,
  message: FlexMessage,
  buttons: QuickReplyButton[],
): Promise<void> {
  if (!event.replyToken) return;
  const withQr = {
    ...message,
    quickReply: { items: buttons.map(quickReplyAction) },
  } as unknown as LineMessage;
  await replyMessage(event.replyToken, [withQr]);
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
    quickReply: { items: buttons.map(quickReplyAction) },
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

// "หนูเก็บคำสั่ง" → the full command reference. Every entry below is a real,
// reachable handler (each works with or without the "หนูเก็บ" prefix); shown in the
// prefixed form since that's how the menu/rich-menu buttons send them. Keep this in
// sync with the handlers in handleTextCommand.
const COMMAND_LIST_TEXT = `หนูเก็บ — คำสั่งทั้งหมด

📁 ไฟล์ & ล็อคเกอร์
หนูเก็บล็อคเกอร์ — เปิดเมนูล็อคเกอร์ (ดูไฟล์ / อัพโหลด)
หนูเก็บอัพโหลดไฟล์ — วิธีส่งไฟล์เข้าคลัง

📄 สแกนเอกสารเป็น PDF
หนูเก็บสแกน — ส่งรูปมาได้เลยหนูจะสแกนให้น้า
หนูเก็บสแกนสี — สแกนเป็น PDF แบบสี
หนูเก็บสแกนขาวดำ — สแกนเป็น PDF แบบขาวดำ
หนูเก็บเสร็จ — รวมรูปที่ส่งมาเป็น PDF
หนูเก็บยกเลิก — ยกเลิกโหมดรวมรูป

👥 ทีม (ใช้ในกลุ่ม)
หนูเก็บผูกทีม — ผูกกลุ่มนี้กับทีม
หนูเก็บยกเลิกผูกทีม — ยกเลิกการผูกกลุ่มกับทีม
หนูเก็บไอดีกลุ่ม — ดูไอดีกลุ่มสำหรับผูกทีม

🎁 เชิญเพื่อน / โค้ด
หนูเก็บเชิญ — ดูโค้ดเชิญเพื่อน (เพิ่มพื้นที่)
หนูเก็บกรอกโค้ด [โค้ด] — กรอกโค้ดเชิญของเพื่อน

ℹ️ อื่นๆ
หนูเก็บ (หรือ เมนู) — เปิดเมนูปุ่มลัด
หนูเก็บวิธีใช้ — วิธีใช้งาน
หนูเก็บแนะนำตัว — หนูเก็บแนะนำตัวเอง
หนูเก็บช่วยเหลือ — ศูนย์ช่วยเหลือ
หนูเก็บคำสั่ง — แสดงคำสั่งทั้งหมด (อันนี้)`;

// /redeem failure copy in the bot's voice, keyed by the service's reasonCode
// (the API route keeps returning the plain `reason` for the dashboard).
const REDEEM_FAIL_TEXT: Record<RedeemFailCode, string> = {
  not_found: 'หนูเก็บ: หาโค้ดนี้ไม่เจอเลยนะ 📋\nลองเช็คตัวพิมพ์อีกทีได้เลย!',
  self: 'หนูเก็บ: กรอกโค้ดตัวเองไม่ได้นะ 😅\nแชร์ให้เพื่อนกรอกแทนนะคะ!',
  already_redeemed: 'หนูเก็บ: กรอกโค้ดไปแล้วนะ 💛\nชวนเพื่อนมากรอกโค้ดของเราแทนได้เลย!',
  chain: 'หนูเก็บ: อันนี้กรอกไม่ได้นะคะ 📄\nลองชวนเพื่อนคนอื่นดูนะ!',
};

/**
 * Normalize command text for exact matching. LINE can deliver Thai text (rich-menu
 * taps, quick-reply echoes, typed input) as non-NFC or with zero-width chars, which
 * broke the old raw `===` compare (same class of bug the invite handler hit). Strip
 * zero-width chars + NFC-normalize both sides so the menu/locker commands still match.
 */
function normalizeCmd(s: string): string {
  return s
    .trim()
    .replace(/[​-‍﻿]/g, '') // remove zero-width chars
    .normalize('NFC')
    .toLowerCase();
}

function isCmd(text: string, ...matches: string[]): boolean {
  const t = normalizeCmd(text);
  return matches.some((m) => t === normalizeCmd(m));
}

/** The bot's address prefix. "หนูเก็บ<cmd>" is an alias for every bare command. */
const BOT_PREFIX = 'หนูเก็บ';

/**
 * Strip a leading "หนูเก็บ" address prefix, returning the remainder plus whether
 * the message was prefixed (i.e. explicitly addressed to the bot). The remainder
 * flows to the existing command handlers unchanged, so "หนูเก็บรวมรูป" reaches the
 * same handler as bare "รวมรูป" without touching that handler. Zero-width chars are
 * removed and the text NFC-normalized (same hardening as normalizeCmd) while the
 * remainder's original case is preserved (referral codes are case-sensitive). Bare
 * "หนูเก็บ" (nothing after) maps to the menu trigger.
 */
function stripBotPrefix(raw: string): { text: string; prefixed: boolean } {
  const cleaned = raw.replace(/[​-‍﻿]/g, '').normalize('NFC').trim();
  if (cleaned.startsWith(BOT_PREFIX)) {
    const rest = cleaned.slice(BOT_PREFIX.length).trim();
    return { text: rest === '' ? 'เมนู' : rest, prefixed: true };
  }
  return { text: cleaned, prefixed: false };
}

/**
 * Shared redeem flow for the "/redeem" and "กรอกโค้ด/ใส่โค้ด/โค้ด" triggers.
 * Wrapped so any DB/Redis error produces an apology reply, never silence (the
 * user was just told to type a code). Sends the same success/fail copy either way.
 */
async function handleRedeem(
  app: FastifyInstance,
  event: LineMessageEvent,
  lineUserId: string,
  rawCode: string | undefined,
): Promise<void> {
  try {
    const code = rawCode?.trim();
    if (!code) {
      await reply(event, 'หนูเก็บ: พิมพ์โค้ดต่อท้ายด้วยนะ 📁\nเช่น กรอกโค้ด ABC12345');
      return;
    }
    if (!/^[a-zA-Z0-9]{1,8}$/.test(code)) {
      await reply(event, 'หนูเก็บ: หาโค้ดนี้ไม่เจอเลยนะ 📋\nลองเช็คตัวพิมพ์อีกทีได้เลย!');
      return;
    }
    const profile = await getProfile(lineUserId).catch(() => undefined);
    const { user } = await ensureUserAndSpace(
      app.supabase,
      lineUserId,
      profile?.displayName,
      profile?.pictureUrl,
    );
    if (!(await checkRedeemRateLimit(app.redis, user.id))) {
      await reply(event, 'หนูเก็บ: พักก่อนนะ 😴\nลองใหม่ได้ในอีก 1 ชั่วโมงนะคะ!');
      return;
    }
    const result = await redeemCode(app.supabase, app.redis, code, user.id);
    if (!result.ok) {
      await reply(event, REDEEM_FAIL_TEXT[result.reasonCode ?? 'not_found']);
      return;
    }
    // Pushes are best-effort — the redemption is already committed.
    try {
      await sendRedeemSuccessToReferee(app.supabase, user.id, result.newStorageBytes!);
    } catch (err) {
      app.log.error({ err, userId: user.id }, 'referral: redeem-success push failed');
    }
    try {
      await sendReferralProgressToReferrer(app.supabase, app.redis, result.referrerId!);
    } catch (err) {
      app.log.error({ err, referrerId: result.referrerId }, 'referral: referrer progress push failed');
    }
  } catch (err) {
    app.log.error({ err, lineUserId }, 'referral: redeem handler error');
    await reply(event, 'หนูเก็บ: ขอโทษนะคะ เกิดข้อผิดพลาด ลองใหม่อีกทีนะคะ 📁').catch(() => {});
  }
}

async function handleTextCommand(
  app: FastifyInstance,
  event: LineMessageEvent,
  text: string,
): Promise<void> {
  const source = event.source;
  const lineUserId = source.userId!;

  // Address-prefix handling. Strip a leading "หนูเก็บ" so every command is reachable
  // as "หนูเก็บ<cmd>" in addition to its bare form; the stripped remainder flows to
  // the handlers below unchanged. `prefixed` = the message was explicitly addressed
  // to the bot.
  const { text: strippedText, prefixed } = stripBotPrefix(text);
  text = strippedText;

  // In group/room chats, stay silent unless the message is addressed to the bot:
  // "หนูเก็บ…"-prefixed, a bare menu word, or the numbered team-pick re-send
  // ("ผูกทีม 2"). 1-on-1 chats also handle bare commands (the tail fallback below
  // only nudges on an UNRECOGNIZED "หนูเก็บ…" message, so random chatter stays quiet).
  if (source.type === 'group' || source.type === 'room') {
    const isBindTeam = /^(?:ผูกทีม|bind team)\s+\d+$/i.test(text.trim());
    if (!prefixed && !isCmd(text, 'menu', 'เมนู') && !isBindTeam) return;
  }

  // Quick-function menu (rich-menu-free shortcut). Shows the common actions as
  // LINE quick-reply buttons — the last one only makes sense inside a group.
  if (isCmd(text, 'หนูเก็บ', 'menu', 'เมนู')) {
    // In group/room the button texts carry a "หนูเก็บ" prefix so their tapped
    // text is unique and passes the group guard without clashing with normal
    // human typing. In 1-on-1 the buttons stay bare (no guard there).
    const inGroup = source.type === 'group' || source.type === 'room';
    // Every button sends the "หนูเก็บ"-prefixed text so it passes the bot-directed
    // gate in group and 1-on-1 alike; the label stays friendly (bare) in 1-on-1.
    const buttons: QuickReplyButton[] = [
      inGroup
        ? { label: 'หนูเก็บล็อคเกอร์', text: 'หนูเก็บล็อคเกอร์' }
        : { label: 'ล็อคเกอร์', text: 'หนูเก็บล็อคเกอร์' },
    ];
    // รวมรูป + สแกน are personal-chat only, so they're not offered in a group menu.
    if (!inGroup) {
      buttons.push({ label: 'รวมรูป', text: 'หนูเก็บรวมรูป' });
      buttons.push({ label: 'สแกน PDF', text: 'หนูเก็บสแกน' });
    }
    buttons.push(
      inGroup
        ? { label: 'หนูเก็บวิธีใช้', text: 'หนูเก็บวิธีใช้' }
        : { label: 'วิธีใช้', text: 'หนูเก็บวิธีใช้' },
    );
    // All-commands reference — always sends the prefixed text so it works in
    // group (passes the bot-directed gate) and 1-on-1 alike.
    buttons.push({ label: 'คำสั่ง', text: 'หนูเก็บคำสั่ง' });
    if (source.type === 'group') {
      buttons.push({ label: 'หนูเก็บไอดีกลุ่ม', text: 'หนูเก็บไอดีกลุ่ม' });
      buttons.push({ label: 'หนูเก็บผูกทีม', text: 'หนูเก็บผูกทีม' });
      buttons.push({ label: 'หนูเก็บยกเลิกผูกทีม', text: 'หนูเก็บยกเลิกผูกทีม' });
    }
    await replyWithQuickReply(event, 'เลือกได้เลยน้า ', buttons);
    return;
  }

  // "ล็อคเกอร์" → quick-reply shortcuts (buttons only, no Flex card) in ALL
  // sources (group AND 1-on-1).
  if (isCmd(text, 'ล็อคเกอร์', 'locker', 'หนูเก็บล็อคเกอร์')) {
    const inGroup = source.type === 'group' || source.type === 'room';
    await replyWithQuickReply(event, 'ล็อคเกอร์น้า เลือกได้เลย', [
      {
        label: inGroup ? 'หนูเก็บดูล็อคเกอร์' : 'ดูล็อคเกอร์',
        uri: `${config.WEB_URL}/dashboard`,
      },
      inGroup
        ? { label: 'หนูเก็บอัพโหลดไฟล์', text: 'หนูเก็บอัพโหลดไฟล์' }
        : { label: 'อัพโหลดไฟล์', text: 'อัพโหลดไฟล์' },
    ]);
    return;
  }

  // Upload helper (the "อัพโหลดไฟล์" quick-reply button) — uploads happen by
  // sending files straight into the chat, so just nudge the user to do that.
  if (isCmd(text, 'อัพโหลดไฟล์', 'upload', 'หนูเก็บอัพโหลดไฟล์')) {
    await reply(event, 'ส่งรูปหรือไฟล์เข้ามาในแชทนี้ได้เลยน้า เดี๋ยวหนูเก็บให้เองน้า');
    return;
  }

  // Team onboarding guide ("หนูเก็บทีม" command / onboarding carousel bubble-5
  // postback). After stripBotPrefix the remainder is "ทีม", so exact-match that
  // (NOT includes — that would shadow "ผูกทีม"/"ยกเลิกผูกทีม", which contain "ทีม").
  // Works in 1-1 and group alike: the "หนูเก็บ"-prefixed form passes the group
  // bot-directed guard above. Grouped with the team commands, before the tail
  // "unrecognized command" catch-all (the exact-match "หนูเก็บ" menu handler above
  // never matches "ทีม", so sitting below it is safe).
  if (isCmd(text, 'ทีม', 'team')) {
    await replyFlex(event, buildTeamGuideFlexMessage());
    return;
  }

  // Unbind this LINE group from its team (group context only; owner/admin only).
  if (isCmd(text, 'หนูเก็บยกเลิกผูกทีม')) {
    if (source.type !== 'group' || !source.groupId) {
      await reply(event, 'ใช้ได้เฉพาะในกลุ่มน้า');
      return;
    }
    const groupId = source.groupId;
    const team = await getTeamByLineGroup(app.supabase, groupId);
    if (!team) {
      await reply(event, 'กลุ่มนี้ยังไม่ได้ผูกกับทีมไหนเลยน้า');
      return;
    }
    // Permission: only owner/admin can unbind (unbindLineGroup enforces this too,
    // but check first so we can reply with a friendly message instead of throwing).
    const userId = await findUserId(app, lineUserId);
    const role = userId ? await getTeamRole(app.supabase, team.id, userId) : null;
    if (!userId || !role || !['owner', 'admin'].includes(role)) {
      await reply(event, 'เฉพาะเจ้าของทีมหรือแอดมินเท่านั้นที่ยกเลิกผูกได้น้า');
      return;
    }
    await unbindLineGroup(app.supabase, team.id, groupId, userId);
    await reply(event, `ยกเลิกการผูกกลุ่มกับทีม ${team.name} เรียบร้อยแล้วน้า`);
    return;
  }

  // Bind this LINE group to the sender's team (group context only). Auto-binds
  // when unambiguous (one team); with several teams the user picks by number
  // ("ผูกทีม 2"). Match the "ผูกทีม"/"bind team" prefix, then parse the rest as
  // an optional 1-based index.
  const bindMatch = /^(?:หนูเก็บผูกทีม|ผูกทีม|bind team)\s*(\d+)?$/i.exec(text.trim());
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
        await reply(event, `ไม่มีทีมที่ ${pick} น้า ลองใหม่ด้วย หนูเก็บผูกทีม [เลข] น้า`);
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
    await reply(event, `มีหลายทีมน้า พิมพ์ หนูเก็บผูกทีม [เลข] เพื่อเลือกได้เลยน้า:\n${teamList}`);
    return;
  }

  // Show this group's LINE Group ID (for binding it to a team in the dashboard)
  if (isCmd(text, 'ไอดีกลุ่ม', 'group id', 'groupid', 'หนูเก็บไอดีกลุ่ม')) {
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

  // Redeem a referral code. Two entry points, same shared flow:
  //   • "/redeem XXXXXXXX"
  //   • "กรอกโค้ด XXXXXXXX" / "ใส่โค้ด XXXXXXXX" / "โค้ด XXXXXXXX"  (easy input)
  // Checked before the "เชิญ" contains-match so the redeem text can never be
  // swallowed by another branch. The prefix regex requires a space after the
  // keyword; everything after it is the code.
  if (/^\/redeem\b/i.test(text.trim())) {
    await handleRedeem(app, event, lineUserId, text.trim().split(/\s+/)[1]);
    return;
  }
  const redeemPrefix = /^(?:กรอกโค้ด|ใส่โค้ด|โค้ด)\s+(.+)$/.exec(text.trim());
  if (redeemPrefix) {
    await handleRedeem(app, event, lineUserId, redeemPrefix[1]);
    return;
  }

  // Show my invite code — contains-match on "เชิญ" (or "/invite" prefix).
  // Robust for Thai text from LINE, which may arrive with zero-width chars or a
  // non-NFC composition that broke the old exact `===` match. Strip zero-width
  // chars, normalize to NFC, then contains-match. Group chats never reach here:
  // the allowlist guard at the top returns first, so bare "เชิญ" only fires 1-on-1.
  const normalizedText = text
    .trim()
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // remove zero-width chars
    .normalize('NFC');
  const isInviteCommand =
    normalizedText.includes('เชิญ') || normalizedText.toLowerCase().startsWith('/invite');
  if (isInviteCommand) {
    // Same silent-fail guard as /redeem: a DB/Redis error must produce an
    // apology reply, never nothing.
    try {
      const profile = await getProfile(lineUserId).catch(() => undefined);
      const { user } = await ensureUserAndSpace(
        app.supabase,
        lineUserId,
        profile?.displayName,
        profile?.pictureUrl,
      );
      const status = await getReferralStatus(app.supabase, app.redis, user.id);
      // Tap-again to re-show the code, or jump straight to the dashboard —
      // saves the user from re-typing "เชิญ".
      await replyFlexWithQuickReply(event, buildInviteFlexMessage(status), [
        { label: '📁 ดูโค้ดอีกครั้ง', text: 'เชิญ' },
        { label: '🌐 เปิดเว็บ', uri: config.WEB_URL },
      ]);
    } catch (err) {
      app.log.error({ err, lineUserId }, 'referral: invite handler error');
      await reply(event, 'หนูเก็บ: ขอโทษนะคะ เกิดข้อผิดพลาด ลองใหม่อีกทีนะคะ 📁').catch(() => {});
    }
    return;
  }

  // Scan-to-PDF session (scan-enhance pipeline, migration 019). All trigger words
  // use "สแกน" so none collide with the separate "รวมรูป" merge feature (Feature A
  // below) once the "หนูเก็บ" prefix is stripped. Three distinct triggers: bare
  // "สแกน"/"scan"/"/scan" starts BW (and just says "already scanning" if a session
  // is open); "สแกนขาวดำ"/"สแกนสี" start in — or switch an active session to — that
  // mode. Starting a session always replies with the "ระบบสแกน" card (buildScanFlex-
  // Message) — NOT the merge card. Personal-chat only (a shared group space would
  // collide scan sessions).
  const scanColor = isCmd(text, 'สแกนสี');
  const scanBw = isCmd(text, 'สแกนขาวดำ');
  const scanPlain = isCmd(text, 'สแกน', 'scan', '/scan');
  if (scanColor || scanBw || scanPlain) {
    if (source.type === 'group' || source.type === 'room') {
      await reply(event, 'ระบบสแกนใช้ได้เฉพาะแชทส่วนตัวน้า');
      return;
    }
    const scanMode: ScanMode = scanColor ? 'color' : 'bw';
    const profile = await getProfile(lineUserId).catch(() => undefined);
    const { user, space } = await ensureUserAndSpace(
      app.supabase,
      lineUserId,
      profile?.displayName,
      profile?.pictureUrl,
    );
    const active = await getActiveSession(app.supabase, user.id);
    if (!active) {
      // No session yet → open one in the requested mode and show the scan card.
      await startSession(app.supabase, user.id, space.id, scanMode, 'scan');
      await replyFlex(event, buildScanFlexMessage());
    } else if (scanPlain) {
      // Bare "สแกน" while already scanning → just acknowledge, keep current mode.
      await reply(event, 'กำลังสแกนอยู่แล้วน้า');
    } else if (scanColor) {
      await setSessionMode(app.supabase, active.id, 'color');
      await reply(event, 'เปลี่ยนเป็นโหมดสีแล้วน้า 🌈');
    } else {
      await setSessionMode(app.supabase, active.id, 'bw');
      await reply(event, 'เปลี่ยนเป็นโหมดขาวดำแล้วน้า 🖤');
    }
    return;
  }

  // Start merge-to-PDF mode (also triggered by the rich-menu "รวมรูปเป็น PDF" cell).
  // NOTE: "สแกน"/"scan"/"/scan" are deliberately NOT triggers here — they belong to
  // the scan-session feature (Feature B above), which handles them first anyway.
  if (isCmd(text, 'รวมรูป', 'รวมรูปเป็น pdf')) {
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
    await startSession(app.supabase, user.id, space.id, config.SCAN_DEFAULT_MODE, 'merge');
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

  // Full command reference ("หนูเก็บคำสั่ง" — also the "คำสั่ง" quick-reply button)
  if (isCmd(text, 'คำสั่ง', 'commands', 'คำสั่งทั้งหมด')) {
    await reply(event, COMMAND_LIST_TEXT);
    return;
  }

  // Scan-to-PDF (rich-menu "สแกนรูปเป็น PDF" cell) — under construction
  if (isCmd(text, 'สแกนรูปเป็น pdf')) {
    await reply(event, 'กำลังอัพเดต 🔧');
    return;
  }

  // How-to / usage guide (rich-menu "วิธีใช้งาน" cell; "เมนู" now opens the menu)
  if (isCmd(text, 'วิธีใช้', 'วิธีใช้งาน', 'help', 'หนูเก็บวิธีใช้')) {
    await reply(event, HELP_TEXT);
    return;
  }
  // Quiet chatter: only respond to an UNRECOGNIZED message when it was addressed
  // to the bot ("หนูเก็บ…"). Bare non-command text in 1-1 now gets no reply (the old
  // catch-all nudge fired on every message). Recognized bare commands are handled
  // above and have already returned.
  if (source.type === 'user' && prefixed) {
    await reply(event, 'หนูไม่เข้าใจคำสั่งนี้น้า พิมพ์ "หนูเก็บคำสั่ง" เพื่อดูคำสั่งทั้งหมดได้เลยน้า');
  }
}

async function handleEvent(app: FastifyInstance, event: LineMessageEvent): Promise<void> {
  // User adds the bot (1-1 chat) → welcome bubble + onboarding carousel.
  if (event.type === 'follow') {
    await sendOnboarding(event);
    return;
  }

  // Bot added to a group/room → same welcome bubble + onboarding carousel.
  if (event.type === 'join') {
    await sendOnboarding(event);
    return;
  }

  // Onboarding-carousel taps arrive as `postback` events whose `data` is an
  // existing "หนูเก็บ…" text command — route it through the same handler as typed
  // text so the taps behave exactly like sending that command.
  if (event.type === 'postback') {
    if (event.source.userId && event.postback?.data) {
      await handleTextCommand(app, event, event.postback.data);
    }
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
        lineUserId, // push target for scan-enhance quality warnings
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
        kind: session.session_kind ?? 'merge',
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
  // No IP rate limiter here: LINE delivers webhooks from a small shared IP pool,
  // so a per-IP limit would 429 a busy Official Account's legitimate traffic and
  // make LINE retry (worsening load). The HMAC signature check below already
  // rejects every illegitimate request, so an IP limiter adds no security value.

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
