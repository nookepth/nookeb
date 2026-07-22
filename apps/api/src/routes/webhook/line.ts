import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { sanitizeJobId } from '@nookeb/shared';
import type {
  AddScanPageJob,
  ConvertToDocxJob,
  CreateDiaryEntryJob,
  LineSource,
  ScanMode,
} from '@nookeb/shared';
import { verifyLineSignature } from '../../middleware/line-verify';
import {
  getChatMemberProfile,
  getProfile,
  replyMessage,
  type LineMessage,
} from '../../services/line.service';
import {
  buildDiaryPromptCard,
  buildFinalizingFlexMessage,
  buildInviteFlexMessage,
  buildMergeFlexMessage,
  buildDocxConvertFlexMessage,
  buildFeatureCarouselMessage,
  buildHelpFlexMessage,
  buildOnboardingCarouselMessage,
  buildPdfMergeFlexMessage,
  buildRedeemSuccessFlexMessage,
  buildScanFlexMessage,
  buildTeamGuideFlexMessage,
  type FlexMessage,
} from '../../services/flex.service';
import { ensureUserAndSpace, findLiveFileByLineMessageId } from '../../services/file.service';
import {
  checkRedeemRateLimit,
  getReferralStatus,
  redeemCode,
  type RedeemFailCode,
} from '../../services/referral.service';
import { sendReferralProgressToReferrer } from '../../services/referral.messages';
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
  incrementExpectedPages,
  setSessionMode,
  setSessionStatus,
  startSession,
} from '../../services/scan.service';
import { addPendingNotify, drainPendingNotify } from '../../services/pending-notify.service';
import { armDocxConvert, consumeDocxConvert } from '../../services/docx-convert.service';
import {
  armDiaryMode,
  consumeDiaryMode,
  setDiaryCaption,
} from '../../services/diary-mode.service';
import { bangkokDateString, countEntries, getEntryByDate } from '../../services/diary.service';
import { formatThaiBuddhistDate } from '../../services/docx-thai-components';
import { isMistralOcrConfigured } from '../../services/mistral-ocr.service';
import { logEvent, type EventType } from '../../services/events.service';
import { handleRegisterCommand, handleTaskPostback } from './task-handlers';
import { buildCreateTaskCard } from '../../services/lineMessage';
import { upsertGroupMember } from '../../services/task.service';
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
  /**
   * LINE marks retried webhook deliveries here. `isRedelivery` is true when LINE
   * re-sends an event it isn't sure we processed — for normal uploads we skip
   * re-enqueuing if the file is already stored (see handleEvent).
   */
  deliveryContext?: { isRedelivery: boolean };
  /** Present on 'postback' events — the tapped action's `data` string. */
  postback?: { data: string };
  /**
   * Present on 'memberJoined' events — the members who just joined the group/
   * room (each carries a `userId`). Used to add them to the assignee roster the
   * instant they join, with zero typing required (ระบบตามงาน).
   */
  joined?: { members: LineEventSource[] };
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

// LINE CDN content has a ~1h TTL and the user has already been told "รับแล้ว",
// so the file-bearing jobs MUST survive transient failures. Retry with backoff.
// (The worker's handlers are written to be safe to re-run — see upload.worker.ts.)
const RETRY_OPTS = { attempts: 3, backoff: { type: 'exponential', delay: 5000 } } as const;

/** Bytes-per-GB — referral bonus/total math for the redeem-success reply card. */
const REFERRAL_GB = 1024 * 1024 * 1024;

/**
 * Onboarding sent on `follow` (1-1 chat) and `join` (group/room): an 8-bubble
 * scrollable carousel Flex message (builder in flex.service.ts). The carousel's
 * per-bubble postback taps are routed by the postback handler in handleEvent.
 */
async function sendOnboarding(event: LineMessageEvent): Promise<void> {
  if (!event.replyToken) return;
  await replyMessage(event.replyToken, [
    buildOnboardingCarouselMessage(),
  ]);
}

/**
 * Pending worker notifications drained for this event (reply-only messaging:
 * workers can't push, so their deferred notices ride along on the next
 * interaction's reply — see pending-notify.service). Filled in handleEvent for
 * 1-on-1 text/postback events; sendReply prepends-and-consumes it so the
 * notices are sent at most once, on whichever reply the handler makes.
 */
const pendingPreface = new WeakMap<LineMessageEvent, LineMessage[]>();

/** Take (and clear) the event's drained notices — empty when none/consumed. */
function takePreface(event: LineMessageEvent): LineMessage[] {
  const preface = pendingPreface.get(event) ?? [];
  if (preface.length > 0) pendingPreface.delete(event);
  return preface;
}

/**
 * Single reply funnel: prepends any drained pending notices (trimmed so the
 * total stays within LINE's 5-messages-per-reply limit). If the reply fails,
 * the notices are re-queued so they aren't lost with the spent token.
 */
async function sendReply(event: LineMessageEvent, messages: LineMessage[]): Promise<void> {
  if (!event.replyToken) return;
  const drained = takePreface(event);
  const room = Math.max(0, 5 - messages.length);
  const preface = drained.slice(0, room);
  // Notices that don't fit this reply go back in the queue for the next one.
  if (drained.length > room && event.source.userId) {
    await addPendingNotify(event.source.userId, drained.slice(room));
  }
  try {
    await replyMessage(event.replyToken, [...preface, ...messages]);
  } catch (err) {
    if (preface.length > 0 && event.source.userId) {
      await addPendingNotify(event.source.userId, preface);
    }
    throw err;
  }
}

async function reply(event: LineMessageEvent, text: string): Promise<void> {
  await sendReply(event, [{ type: 'text', text }]);
}

async function replyFlex(event: LineMessageEvent, message: FlexMessage): Promise<void> {
  await sendReply(event, [message]);
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
  await sendReply(event, [withQr]);
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
  await sendReply(event, [message]);
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

• ส่งรูปหรือไฟล์เข้ามาในแชทได้เลยน้า เดี๋ยวหนูเก็บให้พี่เอง
• อยากรวมรูปหลายหน้าเป็น PDF พิมพ์ "หนูเก็บรวมรูป" ได้เลยน้า
• อยากรวมไฟล์ PDF หลายไฟล์เป็นไฟล์เดียว พิมพ์ "หนูเก็บรวมไฟล์" น้า
• อยากสแกนเป็น PDF พิมพ์ "หนูเก็บสแกนสี" หรือ "หนูเก็บสแกนขาวดำ" น้า
• อยากได้ไฟล์ Word แก้ต่อได้ พิมพ์ "หนูเก็บแปลงไฟล์" แล้วส่งรูปหรือ PDF มาน้า
• อยากทำไดอารี่ 365 วัน พิมพ์ "หนูเก็บไดอารี่" แล้วส่งรูป 1 รูปมาน้า
• เปิดคลังไฟล์ ค้นหา จัดโฟลเดอร์ได้ที่ ${config.WEB_URL}/dashboard เลยน้า`;

// Rich-menu "แนะนำตัว" cell → the bot's self-introduction (message action, since the
// webhook has no postback handler — rich-menu buttons send these trigger words as text).
const INTRO_TEXT = `ทุกอย่างที่พี่อยากเก็บ ฝากหนูได้เลยน้า 📁✨`;

// Rich-menu "ช่วยเหลือ" cell → contact support.
const SUPPORT_TEXT = `มีอะไรให้หนูช่วยไหมน้า 🙏
พี่ทักหาทีมงานหนูเก็บได้เลยน้า
🫱 https://lin.ee/Z0ewNYb`;

// "หนูเก็บคำสั่ง" → the full command reference. Every entry below is a real,
// reachable handler (each works with or without the "หนูเก็บ" prefix); shown in the
// prefixed form since that's how the menu/rich-menu buttons send them. Keep this in
// sync with the handlers in handleTextCommand.
const COMMAND_LIST_TEXT = `หนูเก็บ — คำสั่งทั้งหมด 📋

📁 ล็อคเกอร์
หนูเก็บล็อคเกอร์ — เปิดคลังไฟล์ของพี่

✨ ฟีเจอร์
หนูเก็บฟีเจอร์ — ดูฟีเจอร์ทั้งหมด
หนูเก็บรวมรูป — รวมรูปหลายใบเป็น PDF
หนูเก็บรวมไฟล์ — รวมไฟล์ PDF หลายไฟล์เป็นไฟล์เดียว
หนูเก็บสแกน — สแกนเอกสารเป็น PDF
หนูเก็บสแกนสี — สแกนแบบสี
หนูเก็บสแกนขาวดำ — สแกนแบบขาวดำ
หนูเก็บแปลงไฟล์ — แปลงรูป/PDF เป็นไฟล์ Word
หนูเก็บไดอารี่ — เก็บความทรงจำ 365 วัน

🌐 เว็บแอป
หนูเก็บกล่องของขวัญ — ส่งกล่องของขวัญให้คนพิเศษ
หนูเก็บห้องนิรภัย — เก็บของสำคัญไว้ให้ปลอดภัย
หนูเก็บงานของฉัน — ดูงานที่ต้องทำ

👥 ทีม (ใช้ในกลุ่ม)
หนูเก็บสร้างงาน — มอบหมายงานในกลุ่ม
หนูเก็บคู่มือทีม — วิธีเริ่มใช้งานแบบทีม
หนูเก็บผูกทีม — ผูกกลุ่มกับทีม
หนูเก็บยกเลิกผูกทีม — ยกเลิกการผูกทีม
หนูเก็บไอดีกลุ่ม — ดูไอดีกลุ่มนี้

🎁 เพื่อน
หนูเก็บเชิญ — รับโค้ดชวนเพื่อน
หนูเก็บกรอกโค้ด [โค้ด] — กรอกโค้ดรับพื้นที่เพิ่ม

ℹ️ ทั่วไป
หนูเก็บ — เปิดเมนูหลัก
หนูเก็บวิธีใช้ — คู่มือการใช้งาน
หนูเก็บแนะนำตัว — ทำความรู้จักหนูเก็บ
หนูเก็บเพิ่มเติม — ดูเพิ่มเติม
ติดต่อหนูเก็บ — ติดต่อทีมงาน

⚙️ ระหว่างใช้ฟีเจอร์
เสร็จ — บอกหนูว่าครบแล้ว
ยกเลิก — หยุดสิ่งที่ทำอยู่`;

// /redeem failure copy in the bot's voice, keyed by the service's reasonCode
// (the API route keeps returning the plain `reason` for the dashboard).
const REDEEM_FAIL_TEXT: Record<RedeemFailCode, string> = {
  not_found: 'หนูหาโค้ดนี้ไม่เจอเลยน้า 📋\nลองเช็คตัวพิมพ์แล้วส่งมาใหม่ได้เลยน้า',
  self: 'กรอกโค้ดตัวเองไม่ได้น้า 😅\nลองแชร์ให้เพื่อนกรอกแทนดูน้า',
  already_redeemed: 'พี่กรอกโค้ดไปแล้วน้า 💛\nชวนเพื่อนมากรอกโค้ดของพี่ต่อได้เลยน้า',
  chain: 'โค้ดนี้กรอกไม่ได้น้า 📄\nลองชวนเพื่อนคนอื่นดูน้า',
};

/**
 * Strip zero-width chars (U+200B–U+200D, U+FEFF) and NFC-normalize. LINE can
 * deliver Thai text (rich-menu taps, quick-reply echoes, typed input) as non-NFC
 * or with zero-width chars, which broke raw `===`/`includes` matching. This is the
 * shared core used by normalizeCmd, stripBotPrefix, and the invite match — extracted
 * so the three can't drift. Callers add their own trim()/toLowerCase() as needed.
 */
function normalizeText(s: string): string {
  return s.replace(/[​-‍﻿]/g, '').normalize('NFC');
}

/**
 * Normalize command text for exact matching: shared strip+NFC, then lowercase.
 */
function normalizeCmd(s: string): string {
  return normalizeText(s.trim()).toLowerCase();
}

function isCmd(text: string, ...matches: string[]): boolean {
  const t = normalizeCmd(text);
  return matches.some((m) => t === normalizeCmd(m));
}

/**
 * Map a (prefix-stripped) command to its analytics intent event — the TOP of
 * each feature funnel (paired with the worker's outcome events). Returns null
 * for unrecognized chatter so we don't log noise. Best-effort only; used purely
 * for the admin dashboard (events.service).
 */
function classifyIntent(text: string, prefixed: boolean): EventType | null {
  if (prefixed && isCmd(text, 'สแกน')) return 'cmd_scan';
  if (prefixed && isCmd(text, 'รวมรูป')) return 'cmd_merge';
  // isCmd is an EXACT match, so รวมไฟล์ / รวมรูป / แปลงไฟล์ never shadow each other.
  if (prefixed && isCmd(text, 'รวมไฟล์')) return 'cmd_pdf_merge';
  if (isCmd(text, 'เสร็จ')) return 'cmd_done';
  if (isCmd(text, 'ยกเลิก')) return 'cmd_cancel';
  if (prefixed && isCmd(text, 'แปลงไฟล์')) return 'cmd_convert_arm';
  if (prefixed && isCmd(text, 'ไดอารี่')) return 'cmd_diary_arm';
  if (prefixed && isCmd(text, 'วิธีใช้')) return 'cmd_help';
  if (isCmd(text, 'ติดต่อหนูเก็บ')) return 'cmd_support';
  return null;
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
  const cleaned = normalizeText(raw).trim();
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
      await reply(event, 'พิมพ์โค้ดต่อท้ายมาด้วยน้า 📮\nเช่น กรอกโค้ด ABC12345 น้า');
      return;
    }
    if (!/^[a-zA-Z0-9]{1,8}$/.test(code)) {
      await reply(event, 'หนูหาโค้ดนี้ไม่เจอเลยน้า 🏷️\nลองเช็คตัวพิมพ์แล้วส่งมาใหม่ได้เลยน้า');
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
      await reply(event, 'ขอพักแป๊บนึงน้า 😴\nอีก 1 ชั่วโมงค่อยลองใหม่นะน้า');
      return;
    }
    const result = await redeemCode(app.supabase, app.redis, code, user.id);
    if (!result.ok) {
      await reply(event, REDEEM_FAIL_TEXT[result.reasonCode ?? 'not_found']);
      return;
    }
    // The referee (this user) typed the code here, so we have a fresh reply
    // token — REPLY the success card. On the success path the token is
    // otherwise unused (only failures call reply() above). Web-dashboard
    // redemptions have no chat token, so theirs is deferred to pending-notify
    // (referral.messages).
    try {
      await replyFlex(
        event,
        buildRedeemSuccessFlexMessage({
          totalGB: Number((result.newStorageBytes! / REFERRAL_GB).toFixed(2)),
          bonusGB: Number((config.REFERRAL_BONUS_BYTES / REFERRAL_GB).toFixed(2)),
          dashboardUrl: `${config.WEB_URL}/dashboard`,
        }),
      );
    } catch (err) {
      app.log.error({ err, userId: user.id }, 'referral: redeem-success reply failed');
    }
    // The referrer is a DIFFERENT user (not in this chat) — no reply token for
    // them ever, so their progress card is deferred to pending-notify and
    // arrives on their next interaction with the bot.
    try {
      await sendReferralProgressToReferrer(app.supabase, app.redis, result.referrerId!);
    } catch (err) {
      app.log.error({ err, referrerId: result.referrerId }, 'referral: referrer progress notify failed');
    }
  } catch (err) {
    app.log.error({ err, lineUserId }, 'referral: redeem handler error');
    await reply(event, 'ขอโทษน้า มีอะไรผิดพลาดนิดหน่อย ลองใหม่อีกทีนะน้า 🔧').catch(() => {});
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
  // ระบบตามงาน roster opt-in ("หนูเก็บลงทะเบียน"). Matched BEFORE the group
  // bot-directed guard below; the prefix passes the guard anyway.
  if (prefixed && isCmd(text, 'ลงทะเบียน')) {
    await handleRegisterCommand(app, event);
    return;
  }

  // ระบบตามงาน "สร้างงาน" entry point — replies ONE self-contained card with an
  // in-card type selector (single/multi/recurring) + สร้างงาน/ดูงานทั้งหมด
  // buttons (was a 3-bubble carousel). Deliberately UNPREFIXED and matched BEFORE
  // the group bot-directed guard so it works when typed straight into a group.
  // The roster is populated automatically by the message-event auto-upsert (no
  // "/register" typing needed), so the card can offer assignees right away.
  if (prefixed && isCmd(text, 'สร้างงาน')) {
    const groupId = source.groupId ?? source.roomId;
    if (!groupId) {
      // 1-on-1 chat: งานส่วนตัว (migration 043). The card carries no id — the
      // LIFF resolves the owner from the verified session.
      await replyFlex(event, buildCreateTaskCard(config.LINE_LIFF_ID, null, 'personal'));
      return;
    }
    await replyFlex(event, buildCreateTaskCard(config.LINE_LIFF_ID, groupId));
    return;
  }

  if (source.type === 'group' || source.type === 'room') {
    const isBindTeam = /^(?:ผูกทีม)\s+\d+$/i.test(text.trim());
    if (!prefixed && !isBindTeam) return;
  }

  // ไดอารี่ caption capture: unprefixed text typed while diary mode is armed
  // becomes the pending entry's caption (1-on-1 only — the mode can only be
  // armed there). setDiaryCaption uses SET XX, so this is a single cheap Redis
  // call that no-ops (false) for everyone not in diary mode. Escape hatches:
  // "ยกเลิก"/"cancel" still cancels, a re-tapped "ไดอารี่" falls through to its
  // handler, and any "หนูเก็บ…"-prefixed command works normally while armed.
  if (
    source.type === 'user' &&
    !prefixed &&
    text.length > 0 &&
    !isCmd(text, 'ยกเลิก', 'ไดอารี่')
  ) {
    let captured = false;
    try {
      captured = await setDiaryCaption(app.redis, lineUserId, text.slice(0, 500));
    } catch (err) {
      app.log.warn({ err, lineUserId }, 'diary caption capture failed — treating as normal text');
    }
    if (captured) {
      await reply(event, 'จดข้อความไว้ให้แล้วน้า ส่งรูปมาได้เลยน้า 🌸');
      return;
    }
  }

  // Analytics: record the command INTENT (funnel top). Fire-and-forget, never
  // awaited on the 1s webhook path; unrecognized chatter classifies to null and
  // isn't logged. user_id is left null here (resolving it would add a DB hit to
  // every message) — funnels use event counts, and DAU is driven by the
  // worker-outcome + web-login events which do carry user_id.
  {
    const intent = classifyIntent(text, prefixed);
    if (intent) {
      void logEvent(app.supabase, {
        eventType: intent,
        source: 'line',
        spaceId: null,
        metadata: { chatType: source.type },
      });
    }
  }

  // Quick-function menu (rich-menu-free shortcut). Shows the common actions as
  // LINE quick-reply buttons — the last one only makes sense inside a group.
  if (prefixed && isCmd(text, 'เมนู')) {
    // Different button sets for 1-on-1 vs group/room. Every button sends a
    // "หนูเก็บ"-prefixed message (or "ติดต่อหนูเก็บ") so its tapped text passes the
    // bot-directed gate in group and 1-on-1 alike without clashing with human typing.
    const inGroup = source.type === 'group' || source.type === 'room';
    const buttons: QuickReplyButton[] = inGroup
      ? [
          { label: 'หนูเก็บล็อคเกอร์', text: 'หนูเก็บล็อคเกอร์' },
          { label: 'หนูเก็บสร้างงาน', text: 'หนูเก็บสร้างงาน' },
          { label: 'หนูเก็บคู่มือทีม', text: 'หนูเก็บคู่มือทีม' },
          { label: 'หนูเก็บวิธีใช้', text: 'หนูเก็บวิธีใช้' },
          { label: 'หนูเก็บคำสั่ง', text: 'หนูเก็บคำสั่ง' },
          { label: 'หนูเก็บเพิ่มเติม', text: 'หนูเก็บเพิ่มเติม' },
        ]
      : [
          { label: 'หนูเก็บล็อคเกอร์', text: 'หนูเก็บล็อคเกอร์' },
          { label: 'หนูเก็บฟีเจอร์', text: 'หนูเก็บฟีเจอร์' },
          { label: 'หนูเก็บวิธีใช้', text: 'หนูเก็บวิธีใช้' },
          { label: 'หนูเก็บคำสั่ง', text: 'หนูเก็บคำสั่ง' },
          { label: 'หนูเก็บเพิ่มเติม', text: 'หนูเก็บเพิ่มเติม' },
          { label: 'ติดต่อหนูเก็บ', text: 'ติดต่อหนูเก็บ' },
        ];
    await replyWithQuickReply(event, 'หนูพร้อมช่วย พี่เลือกได้เลย 💫', buttons);
    return;
  }

  // "หนูเก็บฟีเจอร์เอกสาร" — rich-menu zone 3. Document-only quick-pick: the three
  // LINE-bot document flows. Matched BEFORE "ฟีเจอร์" because isCmd is exact —
  // the two are distinct commands, not prefixes of one another. Unlike "ฟีเจอร์"
  // this works in groups too: all three targets already explain themselves when
  // they're personal-chat only, so a group tap gets a useful reply either way.
  if (prefixed && isCmd(text, 'ฟีเจอร์เอกสาร')) {
    await replyWithQuickReply(event, 'เลือกฟีเจอร์เอกสารที่ต้องการ', [
      { label: 'แปลงไฟล์', text: 'หนูเก็บแปลงไฟล์' },
      { label: 'สแกนสี', text: 'หนูเก็บสแกนสี' },
      { label: 'รวมรูป', text: 'หนูเก็บรวมรูป' },
      { label: 'รวมไฟล์ PDF', text: 'หนูเก็บรวมไฟล์' },
    ]);
    return;
  }

  // "หนูเก็บฟีเจอร์" — feature quick-pick (1-on-1 only). Buttons only, no flex
  // card: message actions for the LINE-bot features + uri actions for the
  // web-only ones (กล่องของขวัญ / ห้องนิรภัย / งานของฉัน).
  if (prefixed && isCmd(text, 'ฟีเจอร์')) {
    if (source.type === 'group' || source.type === 'room') {
      await reply(event, 'ฟีเจอร์นี้ทักหนูมาในแชทส่วนตัวได้เลยน้า 🤗');
      return;
    }
    await replyWithQuickReply(event, 'พี่เลือกฟีเจอร์ที่อยากใช้ได้เลยน้า 🌟', [
      { label: 'หนูเก็บไดอารี่', text: 'หนูเก็บไดอารี่' },
      { label: 'หนูเก็บแปลงไฟล์', text: 'หนูเก็บแปลงไฟล์' },
      { label: 'หนูเก็บสแกนสี', text: 'หนูเก็บสแกนสี' },
      { label: 'หนูเก็บรวมรูป', text: 'หนูเก็บรวมรูป' },
      { label: 'หนูเก็บรวมไฟล์', text: 'หนูเก็บรวมไฟล์' },
      { label: 'หนูเก็บกล่องของขวัญ', uri: 'https://nookeb-web.vercel.app/dashboard/legacy-box' },
      { label: 'หนูเก็บห้องนิรภัย', uri: 'https://nookeb-web.vercel.app/dashboard/vault' },
      { label: 'หนูเก็บงานของฉัน', uri: 'https://nookeb-web.vercel.app/dashboard/tasks' },
    ]);
    return;
  }

  // Web-only feature shortcuts (1-on-1 only). Each replies a friendly line plus a
  // uri quick-reply that opens the matching dashboard page. Prefixed so the taps
  // pass the group bot-directed guard; in a group they explain it's personal-chat only.
  if (prefixed && isCmd(text, 'กล่องของขวัญ')) {
    if (source.type === 'group' || source.type === 'room') {
      await reply(event, 'ฟีเจอร์นี้ใช้ได้เฉพาะแชทส่วนตัวน้าพี่ 🏠');
      return;
    }
    await replyWithQuickReply(event, 'เปิดกล่องของขวัญให้เลยน้าพี่ 🎁', [
      { label: 'เปิดกล่องของขวัญ', uri: 'https://nookeb-web.vercel.app/dashboard/legacy-box' },
    ]);
    return;
  }

  if (prefixed && isCmd(text, 'ห้องนิรภัย')) {
    if (source.type === 'group' || source.type === 'room') {
      await reply(event, 'ฟีเจอร์นี้ใช้ได้เฉพาะแชทส่วนตัวน้าพี่ 🏠');
      return;
    }
    await replyWithQuickReply(event, 'เปิดห้องนิรภัยให้เลยน้าพี่ 🔐', [
      { label: 'เปิดห้องนิรภัย', uri: 'https://nookeb-web.vercel.app/dashboard/vault' },
    ]);
    return;
  }

  if (prefixed && isCmd(text, 'งานของฉัน')) {
    if (source.type === 'group' || source.type === 'room') {
      await reply(event, 'ฟีเจอร์นี้ใช้ได้เฉพาะแชทส่วนตัวน้าพี่ 🏠');
      return;
    }
    await replyWithQuickReply(event, 'เปิดหน้างานให้เลยน้าพี่ 📬', [
      { label: 'ดูงานของฉัน', uri: 'https://nookeb-web.vercel.app/dashboard/tasks' },
    ]);
    return;
  }

  // "หนูเก็บเพิ่มเติม" — group shows a group-admin sub-menu (3 quick replies);
  // 1-on-1 shows an informational feature-image carousel (safe in both contexts).
  if (prefixed && isCmd(text, 'เพิ่มเติม')) {
    if (source.type === 'group' || source.type === 'room') {
      await replyWithQuickReply(event, 'เลือกเมนูเพิ่มเติมได้เลยน้า 🎛️', [
        { label: 'หนูเก็บผูกทีม', text: 'หนูเก็บผูกทีม' },
        { label: 'หนูเก็บยกเลิกผูกทีม', text: 'หนูเก็บยกเลิกผูกทีม' },
        { label: 'หนูเก็บไอดีกลุ่ม', text: 'หนูเก็บไอดีกลุ่ม' },
      ]);
      return;
    }
    await replyFlex(event, buildFeatureCarouselMessage());
    return;
  }

  // "ล็อคเกอร์" → quick-reply shortcuts (buttons only, no Flex card) in ALL
  // sources (group AND 1-on-1).
  if (prefixed && isCmd(text, 'ล็อคเกอร์')) {
    const inGroup = source.type === 'group' || source.type === 'room';
    await replyWithQuickReply(event, 'เปิดดูล็อคเกอร์ได้เลยน้า 🗄️', [
      {
        label: inGroup ? 'หนูเก็บดูล็อคเกอร์' : 'ดูล็อคเกอร์',
        uri: `${config.WEB_URL}/dashboard`,
      },
    ]);
    return;
  }

  // Team onboarding guide ("หนูเก็บคู่มือทีม" command / onboarding carousel
  // bubble-5 postback). After stripBotPrefix the remainder is "คู่มือทีม", exact-
  // matched. Works in 1-1 and group alike: the "หนูเก็บ"-prefixed form passes the
  // group bot-directed guard above. Grouped with the team commands, before the tail
  // "unrecognized command" catch-all.
  if (prefixed && isCmd(text, 'คู่มือทีม')) {
    await replyFlex(event, buildTeamGuideFlexMessage());
    return;
  }

  // Unbind this LINE group from its team (group context only; owner/admin only).
  if (prefixed && isCmd(text, 'ยกเลิกผูกทีม')) {
    if (source.type !== 'group' || !source.groupId) {
      await reply(event, 'อันนี้ใช้ในกลุ่มน้า ลองพิมพ์ในกลุ่มดูน้า 🤝');
      return;
    }
    const groupId = source.groupId;
    const team = await getTeamByLineGroup(app.supabase, groupId);
    if (!team) {
      await reply(event, 'กลุ่มนี้ยังไม่ได้ผูกกับทีมไหนเลยน้า 🔗');
      return;
    }
    // Permission: only owner/admin can unbind (unbindLineGroup enforces this too,
    // but check first so we can reply with a friendly message instead of throwing).
    const userId = await findUserId(app, lineUserId);
    const role = userId ? await getTeamRole(app.supabase, team.id, userId) : null;
    if (!userId || !role || !['owner', 'admin'].includes(role)) {
      await reply(event, 'ต้องเป็นเจ้าของทีมก่อนนะน้า ถึงจะยกเลิกผูกได้น้า 🔑');
      return;
    }
    await unbindLineGroup(app.supabase, team.id, groupId, userId);
    await reply(event, `ยกเลิกการผูกกลุ่มกับทีม ${team.name} เรียบร้อยแล้วน้า ✂️`);
    return;
  }

  // Bind this LINE group to the sender's team (group context only). Auto-binds
  // when unambiguous (one team); with several teams the user picks by number
  // ("ผูกทีม 2"). Match the "ผูกทีม"/"bind team" prefix, then parse the rest as
  // an optional 1-based index.
  const bindMatch = /^(?:หนูเก็บผูกทีม|ผูกทีม)\s*(\d+)?$/i.exec(text.trim());
  if (bindMatch) {
    if (source.type !== 'group' || !source.groupId) {
      await reply(event, 'คำสั่งนี้ใช้ในกลุ่มน้า ลองพิมพ์ในกลุ่มดูน้า 🧩');
      return;
    }
    const groupId = source.groupId;
    const pick = bindMatch[1] ? Number(bindMatch[1]) : null; // 1-based, or null

    const existing = await getTeamByLineGroup(app.supabase, groupId);
    if (existing) {
      await reply(event, `กลุ่มนี้ผูกกับทีม ${existing.name} อยู่แล้วน้า 🏢`);
      return;
    }

    const userId = await findUserId(app, lineUserId);
    const teams = userId ? await listUserTeams(app.supabase, userId) : [];

    if (teams.length === 0 || !userId) {
      await reply(event, 'พี่ยังไม่มีทีมเลยน้า ไปสร้างทีมที่แดชบอร์ดก่อนได้เลยน้า 🧭');
      return;
    }

    // Explicit pick ("ผูกทีม 2") — bind that team regardless of team count.
    if (pick !== null) {
      const chosen = teams[pick - 1];
      if (!chosen) {
        await reply(event, `ไม่มีทีมลำดับที่ ${pick} น้า ลองใหม่ด้วย หนูเก็บผูกทีม [เลข] น้า 🔍`);
        return;
      }
      await bindLineGroup(app.supabase, chosen.team.id, groupId, userId);
      await reply(event, `ผูกกลุ่มกับทีม ${chosen.team.name} เรียบร้อยแล้วน้า 🔗`);
      return;
    }

    if (teams.length === 1 && teams[0]) {
      // Unambiguous → auto-bind.
      const only = teams[0];
      await bindLineGroup(app.supabase, only.team.id, groupId, userId);
      await reply(
        event,
        `ผูกกลุ่มกับทีม ${only.team.name} แล้วน้า\nส่งไฟล์ในกลุ่มนี้จะเข้าพื้นที่ทีมเลย 🔗`,
      );
      return;
    }
    // More than one team → list them numbered; the user re-sends "ผูกทีม [เลข]".
    const teamList = teams.map((t, i) => `${i + 1}. ${t.team.name}`).join('\n');
    await reply(event, `มีหลายทีมน้า พิมพ์ หนูเก็บผูกทีม [เลข] เพื่อเลือกได้เลยน้า 🔢:\n${teamList}`);
    return;
  }

  // Show this group's LINE Group ID (for binding it to a team in the dashboard)
  if (prefixed && isCmd(text, 'ไอดีกลุ่ม')) {
    if (source.type !== 'group' || !source.groupId) {
      await reply(event, 'คำสั่งนี้ใช้ในกลุ่มน้า ลองพิมพ์ในกลุ่มดูน้า 🪪');
      return;
    }
    const groupId = source.groupId;
    const team = await getTeamByLineGroup(app.supabase, groupId);
    if (team) {
      await reply(event, `ไอดีกลุ่มนี้คือ:\n${groupId}\n\nผูกกับทีม: ${team.name} แล้วน้า 🆔`);
    } else {
      await reply(
        event,
        `ไอดีกลุ่มนี้คือ:\n${groupId}\n\nยังไม่ได้ผูกกับทีมไหนน้า เอาไอดีนี้ไปใส่ในแดชบอร์ด → ทีม → ผูกกลุ่ม ได้เลยน้า 📇`,
      );
    }
    return;
  }

  // (The group notification toggle — "หนูเก็บปิดแจ้งเตือน" / "เปิดแจ้งเตือน",
  // migration 021 — was retired: group/room uploads are now stored SILENTLY,
  // always, so there is nothing to toggle. The words fall through to the
  // quiet-chatter rule and are ignored.)

  // Redeem a referral code: "กรอกโค้ด XXXXXXXX". Checked before the "เชิญ" match
  // so the redeem text can never be swallowed by another branch. The regex
  // requires a space after the keyword; everything after it is the code.
  const redeemPrefix = /^(?:กรอกโค้ด)\s+(.+)$/.exec(text.trim());
  if (redeemPrefix) {
    await handleRedeem(app, event, lineUserId, redeemPrefix[1]);
    return;
  }

  // Show my invite code — keyword "หนูเก็บเชิญ" (prefixed + startsWith "เชิญ" on
  // the stripped remainder). startsWith (not exact) so "หนูเก็บเชิญเพื่อน" and any
  // trailing text still match, while a message that merely *contains* "เชิญ"
  // (e.g. "ยกเลิกคำเชิญ") isn't swallowed here.
  const normalizedText = normalizeText(text.trim());
  const isInviteCommand = prefixed && normalizedText.startsWith('เชิญ');
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
        { label: '📁 ดูโค้ดอีกครั้ง', text: 'หนูเก็บเชิญ' },
        { label: '🌐 เปิดเว็บ', uri: config.WEB_URL },
      ]);
    } catch (err) {
      app.log.error({ err, lineUserId }, 'referral: invite handler error');
      await reply(event, 'ขอโทษน้า มีอะไรผิดพลาดนิดหน่อย ลองใหม่อีกทีนะน้า 🔧').catch(() => {});
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
  const scanColor = prefixed && isCmd(text, 'สแกนสี');
  const scanBw = prefixed && isCmd(text, 'สแกนขาวดำ');
  const scanPlain = prefixed && isCmd(text, 'สแกน');
  if (scanColor || scanBw || scanPlain) {
    if (source.type === 'group' || source.type === 'room') {
      await reply(event, 'ระบบสแกนทักหนูมาในแชทส่วนตัวได้เลยน้า 📸');
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
      await reply(event, 'หนูกำลังสแกนให้อยู่แล้วน้า 🗂️');
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
  if (prefixed && isCmd(text, 'รวมรูป')) {
    // Merge-to-PDF is a personal-chat feature only — group scan sessions would
    // collide across members sharing one group space.
    if (source.type === 'group' || source.type === 'room') {
      await reply(event, 'ระบบรวมรูปทักหนูมาในแชทส่วนตัวได้เลยน้า 🖼️');
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

  // Start PDF-merge mode ("หนูเก็บรวมไฟล์", migration 044) — the same session
  // machinery as รวมรูป above, kind 'pdf': the collected items are whole PDF
  // documents and finalize_scan concatenates them instead of embedding images.
  // Personal-chat only, like every other session mode (a shared group space
  // would collide sessions across members). startSession auto-cancels any
  // session already collecting for this user, so switching modes mid-flight
  // (e.g. รวมรูป → รวมไฟล์) needs no special handling here.
  if (prefixed && isCmd(text, 'รวมไฟล์')) {
    if (source.type === 'group' || source.type === 'room') {
      await reply(event, 'ระบบรวมไฟล์ทักหนูมาในแชทส่วนตัวได้เลยน้า 📄');
      return;
    }
    const profile = await getProfile(lineUserId).catch(() => undefined);
    const { user, space } = await ensureUserAndSpace(
      app.supabase,
      lineUserId,
      profile?.displayName,
      profile?.pictureUrl,
    );
    await startSession(app.supabase, user.id, space.id, config.SCAN_DEFAULT_MODE, 'pdf');
    await replyFlex(event, buildPdfMergeFlexMessage({ kind: 'opened' }));
    return;
  }

  // ไดอารี่ 365 วัน ("หนูเก็บไดอารี่") — arms a one-shot Redis flag like
  // แปลงไฟล์: the NEXT image this user sends becomes today's diary entry
  // (optionally captioned by text typed while armed — see the capture block at
  // the top). Personal-chat only; one entry per Bangkok calendar day, checked
  // here at arm time so the user learns immediately instead of after sending a
  // photo (the worker + unique index re-check as backstops).
  if (prefixed && isCmd(text, 'ไดอารี่')) {
    if (source.type === 'group' || source.type === 'room') {
      await reply(event, 'ไดอารี่ทักหนูมาในแชทส่วนตัวได้เลยน้า 📓');
      return;
    }
    try {
      const profile = await getProfile(lineUserId).catch(() => undefined);
      const { user } = await ensureUserAndSpace(
        app.supabase,
        lineUserId,
        profile?.displayName,
        profile?.pictureUrl,
      );
      const today = bangkokDateString();
      const existing = await getEntryByDate(app.supabase, user.id, today);
      if (existing) {
        await replyWithQuickReply(event, 'วันนี้พี่บันทึกไว้แล้วน้า 🌸 พรุ่งนี้มาทำต่อได้เลยน้า', [
          { label: 'ดูไดอารี่ของฉัน', uri: `${config.WEB_URL}/dashboard/diary` },
        ]);
        return;
      }
      await armDiaryMode(app.redis, lineUserId);
      const nextDayNumber = (await countEntries(app.supabase, user.id)) + 1;
      const [y, m, d] = today.split('-').map(Number);
      await replyFlex(
        event,
        buildDiaryPromptCard({
          dateThai: formatThaiBuddhistDate(new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)),
          nextDayNumber,
        }),
      );
    } catch (err) {
      // Same silent-fail guard as /redeem: a DB/Redis error must produce an
      // apology reply, never nothing.
      app.log.error({ err, lineUserId }, 'diary: arm handler error');
      await reply(event, 'ขอโทษน้า มีอะไรผิดพลาดนิดหน่อย ลองใหม่อีกทีนะน้า 🔧').catch(() => {});
    }
    return;
  }

  // Convert-to-Word ("หนูเก็บแปลงไฟล์") — arms a one-shot Redis flag; the NEXT
  // image/PDF this user sends is OCR'd (Mistral) and rebuilt as an editable
  // .docx instead of being archived as-is. Personal-chat only, like scan (a
  // shared group flag would convert other members' uploads). Feature-gated on
  // the Mistral key: without it the command explains it's unavailable.
  if (prefixed && isCmd(text, 'แปลงไฟล์')) {
    if (source.type === 'group' || source.type === 'room') {
      await reply(event, 'ระบบแปลงไฟล์ทักหนูมาในแชทส่วนตัวได้เลยน้า 📝');
      return;
    }
    if (!isMistralOcrConfigured()) {
      await reply(event, 'ระบบแปลงไฟล์ยังไม่เปิดตอนนี้น้า รอติดตามเร็วๆ นี้เลยน้า 🪄');
      return;
    }
    await armDocxConvert(app.redis, lineUserId);
    await replyFlex(event, buildDocxConvertFlexMessage());
    return;
  }

  const userId = await findUserId(app, lineUserId);
  const session = userId ? await getActiveSession(app.supabase, userId) : null;

  // Finish merge → build the PDF ("รวมรูป" moved to the start triggers above).
  // Kind-aware copy: one "เสร็จ" serves all three session modes (สแกน / รวมรูป /
  // รวมไฟล์ PDF), so every message here names the mode the user is actually in.
  if (isCmd(text, 'เสร็จ')) {
    if (!session) {
      await reply(event, 'พี่ยังไม่ได้เปิดโหมดไหนเลยน้า พิมพ์ "หนูเก็บรวมรูป" หรือ "หนูเก็บรวมไฟล์" ก่อนแล้วค่อยส่งมาน้า 🧺');
      return;
    }
    const kind = session.session_kind ?? 'merge';
    const pages = await countPages(app.supabase, session.id);
    if (pages === 0) {
      await cancelSession(app.supabase, session.id);
      await reply(
        event,
        kind === 'pdf'
          ? 'ยังไม่มีไฟล์เลยน้า ส่งไฟล์ PDF มาก่อนได้เลยน้า หนูปิดโหมดให้ก่อนนะน้า 🌀'
          : 'ยังไม่มีรูปให้รวมเลยน้า หนูปิดโหมดรวมรูปให้ก่อนนะน้า 🌀',
      );
      return;
    }
    // Compare-and-set collecting → processing: if a concurrent "เสร็จ" already
    // flipped it, only one request enqueues finalize_scan (the fixed jobId
    // dedups too, but this stops the double reply as well).
    const flipped = await setSessionStatus(app.supabase, session.id, 'processing', 'collecting');
    if (!flipped) {
      await reply(event, 'หนูกำลังรวมไฟล์ให้อยู่น้า รอแป๊บนึงนะน้า ⏳');
      return;
    }
    await app.fileQueue.add(
      'finalize_scan',
      { type: 'finalize_scan', sessionId: session.id, lineUserId },
      { jobId: sanitizeJobId('scan-final', session.id), ...RETRY_OPTS },
    );
    // Reply the finalize-in-progress card HERE (fresh reply token) with a
    // "ดูล็อคเกอร์" button — this replaces the old worker-side completion PUSH.
    // The merged PDF shows up in the locker once finalize_scan finishes.
    await replyFlex(
      event,
      buildFinalizingFlexMessage({
        kind,
        count: pages,
        dashboardUrl: `${config.WEB_URL}/dashboard`,
      }),
    );
    return;
  }

  // Cancel merge session / convert-to-Word mode / diary mode
  if (isCmd(text, 'ยกเลิก')) {
    // Disarm both one-shot flags unconditionally (harmless no-ops when not armed).
    const wasArmed = await consumeDocxConvert(app.redis, lineUserId);
    const diaryWasArmed = (await consumeDiaryMode(app.redis, lineUserId)) !== null;
    if (session) {
      await cancelSession(app.supabase, session.id);
      // Message keys off the session kind (scan vs merge) so the confirmation
      // names the mode the user was actually in. session_kind is existing state
      // (set at startSession); this only picks the copy, not the logic.
      const cancelledKind = session.session_kind ?? 'merge';
      if (cancelledKind === 'scan') {
        await reply(event, 'ยกเลิกโหมดสแกนให้แล้วน้า 🚫');
      } else if (cancelledKind === 'pdf') {
        await reply(event, 'ยกเลิกโหมดรวมไฟล์ให้แล้วน้า 🚫');
      } else {
        await reply(event, 'ยกเลิกโหมดรวมรูปให้แล้วน้า 🚫');
      }
    } else if (diaryWasArmed) {
      await reply(event, 'ยกเลิกโหมดไดอารี่ให้แล้วน้า 📕');
    } else if (wasArmed) {
      await reply(event, 'ยกเลิกโหมดแปลงไฟล์ให้แล้วน้า 🗑️');
    } else {
      await reply(event, 'ตอนนี้พี่ยังไม่ได้อยู่ในโหมดไหนเลยน้า 💡');
    }
    return;
  }

  // Self-introduction (rich-menu "แนะนำตัว" cell; "หนูเก็บ" now opens the menu)
  if (prefixed && isCmd(text, 'แนะนำตัว')) {
    await reply(event, INTRO_TEXT);
    return;
  }

  // Support (keyword "ติดต่อหนูเก็บ")
  if (isCmd(text, 'ติดต่อหนูเก็บ')) {
    await reply(event, SUPPORT_TEXT);
    return;
  }

  // Full command reference ("หนูเก็บคำสั่ง")
  if (prefixed && isCmd(text, 'คำสั่ง')) {
    await reply(event, COMMAND_LIST_TEXT);
    return;
  }

  // How-to / usage guide ("หนูเก็บวิธีใช้")
  if (prefixed && isCmd(text, 'วิธีใช้')) {
    await replyFlex(event, buildHelpFlexMessage());
    return;
  }
  // Quiet chatter: only respond to an UNRECOGNIZED message when it was addressed
  // to the bot ("หนูเก็บ…"). Bare non-command text in 1-1 now gets no reply (the old
  // catch-all nudge fired on every message). Recognized bare commands are handled
  // above and have already returned.
  if (source.type === 'user' && prefixed) {
    await reply(event, 'หนูไม่เข้าใจคำสั่งนี้น้า พิมพ์ "หนูเก็บคำสั่ง" เพื่อดูคำสั่งทั้งหมดได้เลยน้า 💬');
  }
}

/**
 * Load the user's deferred worker notifications onto this event so the reply
 * helpers prepend them (see pendingPreface). 1-on-1 only — group replies must
 * never leak someone's personal locker/quota notices into a shared chat — and
 * only when there's a token to eventually deliver them with.
 */
async function drainPendingForEvent(
  app: FastifyInstance,
  event: LineMessageEvent,
  lineUserId: string,
): Promise<void> {
  if (event.source.type !== 'user' || !event.replyToken) return;
  try {
    const pending = await drainPendingNotify(lineUserId);
    if (pending.length > 0) pendingPreface.set(event, pending);
  } catch (err) {
    app.log.warn({ err, lineUserId }, 'pending-notify drain failed — continuing without');
  }
}

/**
 * The handler above didn't reply (quiet chatter / group-guard return), so the
 * token is still fresh — deliver the drained notices on their own. A failed
 * delivery re-queues them for the next interaction.
 */
async function deliverLeftoverPending(
  app: FastifyInstance,
  event: LineMessageEvent,
  lineUserId: string,
): Promise<void> {
  const leftover = takePreface(event);
  if (leftover.length === 0 || !event.replyToken) return;
  try {
    await replyMessage(event.replyToken, leftover);
  } catch (err) {
    app.log.warn({ err, lineUserId }, 'pending-notify delivery failed — re-queueing');
    await addPendingNotify(lineUserId, leftover);
  }
}

/**
 * ระบบตามงาน roster auto-fill: opt a LINE user into their group's assignee
 * roster (group_members) with ZERO typing required. Called from EVERY
 * group/room-scoped webhook event that carries a member userId — `message`,
 * `postback`, `unsend`, and (the key one) `memberJoined`, which enrolls a
 * brand-new member the instant they join instead of waiting for them to chat.
 *
 * Best-effort + fire-and-forget: it must never block the reply nor throw into
 * the 1s webhook path (failures are swallowed + logged). NULL profile fields
 * never overwrite an already-resolved name/avatar (see upsertGroupMember), and
 * the row is NEVER deleted/expired — a member who later leaves stays assignable
 * to their outstanding tasks.
 */
function autoUpsertGroupMember(app: FastifyInstance, groupId: string, lineUserId: string): void {
  void (async () => {
    try {
      // Group-scoped profile fetch — the friend-only /v2/bot/profile endpoint
      // 404s for members who never added the OA, which left roster rows NULL.
      const profile = await getChatMemberProfile(groupId, lineUserId);
      await upsertGroupMember(
        app.supabase,
        groupId,
        lineUserId,
        profile?.displayName ?? null,
        profile?.pictureUrl ?? null,
      );
    } catch (err) {
      app.log.warn({ err, groupId, lineUserId }, 'group member auto-upsert failed');
    }
  })();
}

async function handleEvent(app: FastifyInstance, event: LineMessageEvent): Promise<void> {
  // User adds the bot (1-1 chat) → welcome bubble + onboarding carousel.
  if (event.type === 'follow') {
    await sendOnboarding(event);
    return;
  }

  // Bot added to a group/room → same welcome bubble + onboarding carousel.
  // NOTE: a `join` event is the BOT joining — its source carries no member
  // userId, so there's nobody to add to the roster here (existing members are
  // enrolled as they chat / via memberJoined for future joins).
  if (event.type === 'join') {
    await sendOnboarding(event);
    return;
  }

  // A member JOINED the group/room → enroll them in the assignee roster
  // IMMEDIATELY (ระบบตามงาน), before they've typed a single message. This is the
  // zero-friction path that fixes "member not showing until they've chatted":
  // LINE's memberJoined event carries each new member's userId, and the display
  // name is resolved via the group-scoped profile endpoint inside
  // autoUpsertGroupMember.
  if (event.type === 'memberJoined') {
    const groupId = event.source.groupId ?? event.source.roomId;
    if (groupId) {
      for (const m of event.joined?.members ?? []) {
        if (m.userId) autoUpsertGroupMember(app, groupId, m.userId);
      }
    }
    return;
  }

  // Message unsend (group/room) is still a live signal the sender is present —
  // keep their roster row fresh. Never used to remove anyone (roster rows are
  // never deleted/expired).
  if (event.type === 'unsend') {
    const groupId = event.source.groupId ?? event.source.roomId;
    if (
      (event.source.type === 'group' || event.source.type === 'room') &&
      groupId &&
      event.source.userId
    ) {
      autoUpsertGroupMember(app, groupId, event.source.userId);
    }
    return;
  }

  // Onboarding-carousel taps arrive as `postback` events whose `data` is an
  // existing "หนูเก็บ…" text command — route it through the same handler as typed
  // text so the taps behave exactly like sending that command.
  if (event.type === 'postback') {
    if (event.source.userId && event.postback?.data) {
      // Roster auto-fill: a group/room postback (task-card / carousel taps) is a
      // live signal the tapper is a member — opt them in (zero typing).
      {
        const groupId = event.source.groupId ?? event.source.roomId;
        if ((event.source.type === 'group' || event.source.type === 'room') && groupId) {
          autoUpsertGroupMember(app, groupId, event.source.userId);
        }
      }
      // ระบบตามงาน Flex buttons (รับทราบ / เสร็จแล้ว) carry URL-encoded data, not
      // a "หนูเก็บ…" text command — route them before the text-command path.
      if (event.postback.data.startsWith('action=task_')) {
        await handleTaskPostback(app, event);
        return;
      }
      await drainPendingForEvent(app, event, event.source.userId);
      try {
        await handleTextCommand(app, event, event.postback.data);
      } finally {
        // Runs whether the handler replied, stayed quiet, or threw before
        // replying — drained notices are either already consumed (empty
        // leftover) or still deliverable on the untouched token.
        await deliverLeftoverPending(app, event, event.source.userId);
      }
    }
    return;
  }

  if (event.type !== 'message' || !event.message) return;
  const { message, source } = event;
  const lineUserId = source.userId;
  if (!lineUserId) return;

  // ระบบตามงาน roster auto-fill: every message event from a group/room opts the
  // sender into that group's assignee roster (group_members). Replaces the manual
  // "/register" opt-in — teammates just chat as usual and become assignable.
  {
    const groupId = source.groupId ?? source.roomId;
    if ((source.type === 'group' || source.type === 'room') && groupId) {
      autoUpsertGroupMember(app, groupId, lineUserId);
    }
  }

  if (message.type === 'text') {
    await drainPendingForEvent(app, event, lineUserId);
    try {
      await handleTextCommand(app, event, message.text ?? '');
    } finally {
      // Same guarantee as the postback path: leftover notices are delivered
      // (or re-queued by sendReply on failure) even if the handler threw.
      await deliverLeftoverPending(app, event, lineUserId);
    }
    return;
  }

  const supported =
    message.type === 'image' ||
    message.type === 'file' ||
    message.type === 'video' ||
    message.type === 'audio';
  if (!supported) return;

  // Diary one-shot (armed by "ไดอารี่"). Checked FIRST among the image claims:
  // it's the most recently/explicitly armed intent, consumed atomically
  // (GETDEL) so exactly one image becomes today's entry — subsequent images in
  // the same burst fall through to the docx/scan/normal-upload paths below.
  // 1-on-1 only (matching where the command can arm it). The Bangkok calendar
  // day is fixed HERE, so an entry can't slip to the next day while the job
  // waits in the queue.
  if (source.type === 'user' && message.type === 'image') {
    const diary = await consumeDiaryMode(app.redis, lineUserId);
    if (diary) {
      const job: CreateDiaryEntryJob = {
        type: 'create_diary_entry',
        lineMessageId: message.id,
        lineUserId,
        caption: (diary.caption ?? '').slice(0, 500),
        entryDate: bangkokDateString(),
        // Reply-only messaging: the token is NOT spent on an ack — the worker
        // replies the result card with it (same pattern as convert_to_docx);
        // a spent/expired token falls back to pending-notify, never a push.
        replyToken: event.replyToken ?? null,
      };
      await app.fileQueue.add('create_diary_entry', job, {
        jobId: sanitizeJobId('diary', message.id),
        ...RETRY_OPTS,
      });
      return;
    }
  }

  // Convert-to-Word one-shot (armed by "แปลงไฟล์"). Checked BEFORE the scan
  // session below: the flag is armed explicitly and consumed atomically
  // (GETDEL), so it always claims exactly one file, even over an older open
  // scan session. 1-on-1 only (matching where the command can arm it). NOTE:
  // a LINE redelivery of an already-converted event falls through to the
  // normal upload path (flag already consumed) — rare, and the jobId dedup
  // prevents a double conversion; worst case the source gets archived too.
  if (source.type === 'user' && (message.type === 'image' || message.type === 'file')) {
    const armed = await consumeDocxConvert(app.redis, lineUserId);
    if (armed) {
      // Pre-download cap for file messages (LINE declares fileSize for those).
      if (message.fileSize && message.fileSize > config.DOCX_CONVERT_MAX_SOURCE_BYTES) {
        const mb = Math.round(config.DOCX_CONVERT_MAX_SOURCE_BYTES / (1024 * 1024));
        await reply(event, `ไฟล์ใหญ่เกิน ${mb}MB น้า ระบบแปลงไฟล์รับได้เท่านี้ก่อนน้า ลองย่อไฟล์หรือแบ่งส่งมาใหม่ได้เลยน้า`);
        return;
      }
      const job: ConvertToDocxJob = {
        type: 'convert_to_docx',
        lineMessageId: message.id,
        lineUserId,
        kind: message.type,
        originalName:
          message.type === 'file' && message.fileName ? message.fileName : timestampName('jpg'),
        fileSize: message.fileSize ?? null,
        // Reply-only messaging: the token is NOT spent on an ack here — it's
        // saved for the worker, whose result/error card becomes the reply when
        // the conversion finishes inside the token's ~1 min validity (the
        // common case; Mistral OCR takes seconds). A spent/expired token falls
        // back to pending-notify, never a push.
        replyToken: event.replyToken ?? null,
      };
      await app.fileQueue.add('convert_to_docx', job, {
        jobId: sanitizeJobId('docx', message.id),
        ...RETRY_OPTS,
      });
      return;
    }
  }

  // An image (สแกน/รวมรูป) or a PDF file (รวมไฟล์ PDF) sent while a session is
  // collecting becomes a page of that session.
  // 1-on-1 chats ONLY (matching where sessions can be opened): without the
  // source check, a user with an open personal scan/merge session who posts an
  // image in a GROUP would have it swallowed into their personal session
  // instead of stored in the group's shared space.
  if ((message.type === 'image' || message.type === 'file') && source.type === 'user') {
    const userId = await findUserId(app, lineUserId);
    const session = userId ? await getActiveSession(app.supabase, userId) : null;
    const sessionKind = session?.session_kind ?? 'merge';

    // A รวมไฟล์ PDF session (migration 044) collects FILES, not images. Reject
    // anything else here rather than letting it fall through to the normal
    // upload path: the user is mid-flow and would otherwise get a silent
    // "archived to locker" with no hint why it didn't join the merge.
    if (session && sessionKind === 'pdf') {
      const name = message.type === 'file' ? (message.fileName ?? '') : '';
      if (message.type !== 'file' || !/\.pdf$/i.test(name)) {
        await reply(event, 'ส่งเฉพาะไฟล์ .pdf น้า หนูรับแค่ PDF ในโหมดนี้เองน้า 📄');
        return;
      }
      if (message.fileSize && message.fileSize > config.PDF_MERGE_MAX_SOURCE_BYTES) {
        const mb = Math.round(config.PDF_MERGE_MAX_SOURCE_BYTES / (1024 * 1024));
        await reply(event, `ไฟล์ใหญ่เกิน ${mb}MB น้า ระบบรวมไฟล์รับได้เท่านี้ก่อนน้า ลองแบ่งไฟล์แล้วส่งมาใหม่ได้เลยน้า`);
        return;
      }
      // Soft cap on sources — everything is buffered in worker memory at merge
      // time. expected_pages counts events already ACCEPTED (including ones
      // whose job hasn't landed), so it leads the stored count during a burst.
      const accepted = Math.max(
        session.expected_pages ?? 0,
        await countPages(app.supabase, session.id),
      );
      if (accepted >= config.PDF_MERGE_MAX_SOURCES) {
        await reply(
          event,
          `รอบนี้รับได้สูงสุด ${config.PDF_MERGE_MAX_SOURCES} ไฟล์น้า พิมพ์ "เสร็จ" เพื่อรวมเท่าที่มีก่อนได้เลยน้า`,
        );
        return;
      }
    }

    // Non-image messages only join image sessions (สแกน/รวมรูป) — a file sent
    // during those falls through to the normal upload path, as before.
    if (session && (sessionKind === 'pdf' || message.type === 'image')) {
      const job: AddScanPageJob = {
        type: 'add_scan_page',
        sessionId: session.id,
        lineMessageId: message.id,
        lineUserId, // pending-notify target for scan-enhance quality warnings
      };
      await app.fileQueue.add('add_scan_page', job, {
        jobId: sanitizeJobId('scan-page', message.id),
        ...RETRY_OPTS,
      });
      // Record that we accepted one more page for this session BEFORE the add_scan_page
      // job lands. finalize_scan (triggered by "เสร็จ") waits until the stored page
      // count catches up to this, so a page whose job is still queued / in CDN-retry
      // backoff isn't silently dropped from the PDF. Fail open — if migration 023 isn't
      // applied yet the RPC errors and the wait-gate simply no-ops.
      try {
        await incrementExpectedPages(app.supabase, session.id);
      } catch (err) {
        app.log.warn({ err, sessionId: session.id }, 'increment_expected_pages failed (migration 023?)');
      }
      // One confirmation per burst, not per image: debounce the reply and show the
      // accumulated session total. `basePageCount` is the count BEFORE this burst;
      // only the first event of a burst uses it (see enqueueScanPageReply).
      const basePageCount = await countPages(app.supabase, session.id);
      enqueueScanPageReply(app, {
        lineUserId,
        replyToken: event.replyToken ?? null,
        target: source.groupId ?? lineUserId,
        basePageCount,
        kind: sessionKind,
      });
      return;
    }
  }

  // LINE occasionally REDELIVERS a webhook event (deliveryContext.isRedelivery)
  // when it isn't sure the first delivery was processed. For normal uploads that
  // would enqueue a SECOND upload_batch and double-store the file (scan pages
  // already dedup by message id via pageExists). If this is a redelivery and the
  // file is already stored, skip re-enqueuing. First deliveries, and redeliveries
  // whose file isn't stored yet, fall through — storeUpload's per-message dedup and
  // the unique index (migration 022) are the final backstop.
  if (event.deliveryContext?.isRedelivery) {
    const existing = await findLiveFileByLineMessageId(app.supabase, message.id);
    if (existing) {
      app.log.info(
        { messageId: message.id, fileId: existing.id },
        'skipping redelivered upload — file already stored',
      );
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
    // Group/room id for the notify-toggle lookup in flush(). Kept separate from
    // lineGroupId (which stays group-only for the worker's space routing) so a
    // room's confirmation reply can still be silenced per its roomId.
    notifyGroupId: source.groupId ?? source.roomId ?? null,
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
