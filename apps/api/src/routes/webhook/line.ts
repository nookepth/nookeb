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
import { getProfile, replyMessage, type LineMessage } from '../../services/line.service';
import {
  buildDiaryPromptCard,
  buildFinalizingFlexMessage,
  buildInviteFlexMessage,
  buildMergeFlexMessage,
  buildDocxConvertFlexMessage,
  buildOnboardingCarouselMessage,
  buildRedeemSuccessFlexMessage,
  buildScanFlexMessage,
  buildTeamGuideFlexMessage,
  type FlexMessage,
} from '../../services/flex.service';
import { ensureUserAndSpace, findLiveFileByLineMessageId } from '../../services/file.service';
import { getGroupNotifySetting, setGroupNotifySetting } from '../../services/group-settings.service';
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

• ส่งรูป/ไฟล์มาในแชท หนูจะเก็บให้เองเลย
• พิมพ์ "หนูเก็บรวมรูป" ถ้าอยากรวมรูปหลายหน้าเป็น PDF 
• พิมพ์ "หนูเก็บสแกนสี" หรือ "หนูเก็บสแกนขาวดำ" ถ้าอยากสแกนเป็น PDF แบบสีหรือขาวดำ
• พิมพ์ "หนูเก็บแปลงไฟล์" แล้วส่งรูปหรือ PDF ถ้าอยากแปลงเป็นไฟล์ Word แก้ไขต่อได้
• พิมพ์ "หนูเก็บไดอารี่" แล้วส่งรูป 1 รูป บันทึกไดอารี่ 365 วัน
• เปิดคลังไฟล์ ค้นหา จัดโฟลเดอร์ได้ที่ https://nookeb-web.vercel.app/dashboard เลยน้า`;

// Rich-menu "แนะนำตัว" cell → the bot's self-introduction (message action, since the
// webhook has no postback handler — rich-menu buttons send these trigger words as text).
const INTRO_TEXT = `สาวัดดีกั้บพี่ๆ ทุกคนน้า~ 📄✨
หนูชื่อ "หนูเก็บ" หนูเกิดมาจากเอกสารที่ใช้งานเสร็จแล้วก็ทิ้งเป็นขยะ หนูเลยตั้งใจจะเก็บกระดาษทั้งหมดให้เป็นไฟล์ เก็บรูป ให้พี่เป็นระเบียบเรียบร้อย ไม่ให้หล่นหาย ไม่ให้กระจัดกระจาย 📁💎

อยากให้เก็บ อยากให้ค้น หรืออยากใช้ฟังก์ชันอื่นๆ เรียกหนูได้ตลอดเลยน้า~ หนูพร้อมช่วยพี่เสมอเยยย 💙`;

// Rich-menu "ช่วยเหลือ" cell → contact support.
const SUPPORT_TEXT = `ขออภัยในความไม่สะดวกนะคะ 🙏
หากต้องการความช่วยเหลือ ติดต่อหนูเก็บได้เลยน้าา
👉 https://lin.ee/Z0ewNYb`;

// "หนูเก็บคำสั่ง" → the full command reference. Every entry below is a real,
// reachable handler (each works with or without the "หนูเก็บ" prefix); shown in the
// prefixed form since that's how the menu/rich-menu buttons send them. Keep this in
// sync with the handlers in handleTextCommand.
const COMMAND_LIST_TEXT = `หนูเก็บ — คำสั่งทั้งหมด

📁 ไฟล์ & ล็อคเกอร์
หนูเก็บล็อคเกอร์ 
หนูเก็บอัพโหลดไฟล์ 

✨ รวมรูป
หนูเก็บรวมรูป

📄 สแกนเอกสารเป็น PDF
หนูเก็บสแกน 
หนูเก็บสแกนสี 
หนูเก็บสแกนขาวดำ 

📝 แปลงไฟล์เป็น Word
หนูเก็บแปลงไฟล์

📔 ไดอารี่ 365 วัน
หนูเก็บไดอารี่

👥 ทีม (ใช้ในกลุ่ม)
หนูเก็บผูกทีม 
หนูเก็บยกเลิกผูกทีม 
หนูเก็บไอดีกลุ่ม 
หนูเก็บปิดแจ้งเตือน 
หนูเก็บเปิดแจ้งเตือน 

🎁 เชิญเพื่อน / โค้ด
หนูเก็บเชิญ 
หนูเก็บกรอกโค้ด [โค้ด]

ℹ️ อื่นๆ
หนูเก็บ (หรือ เมนู) 
หนูเก็บวิธีใช้
หนูเก็บแนะนำตัว 
หนูเก็บช่วยเหลือ 
หนูเก็บคำสั่ง`;

// /redeem failure copy in the bot's voice, keyed by the service's reasonCode
// (the API route keeps returning the plain `reason` for the dashboard).
const REDEEM_FAIL_TEXT: Record<RedeemFailCode, string> = {
  not_found: 'หนูเก็บ: หาโค้ดนี้ไม่เจอเลยนะ 📋\nลองเช็คตัวพิมพ์อีกทีได้เลย!',
  self: 'หนูเก็บ: กรอกโค้ดตัวเองไม่ได้นะ 😅\nแชร์ให้เพื่อนกรอกแทนนะคะ!',
  already_redeemed: 'หนูเก็บ: กรอกโค้ดไปแล้วนะ 💛\nชวนเพื่อนมากรอกโค้ดของเราแทนได้เลย!',
  chain: 'หนูเก็บ: อันนี้กรอกไม่ได้นะคะ 📄\nลองชวนเพื่อนคนอื่นดูนะ!',
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
function classifyIntent(text: string): EventType | null {
  if (isCmd(text, 'สแกน', 'scan')) return 'cmd_scan';
  if (isCmd(text, 'รวมรูป', 'merge')) return 'cmd_merge';
  if (isCmd(text, 'เสร็จ', 'done')) return 'cmd_done';
  if (isCmd(text, 'ยกเลิก', 'cancel')) return 'cmd_cancel';
  if (isCmd(text, 'แปลงไฟล์', 'word')) return 'cmd_convert_arm';
  if (isCmd(text, 'ไดอารี่', 'ไดอารี่วันนี้', 'diary')) return 'cmd_diary_arm';
  if (isCmd(text, 'วิธีใช้', 'help')) return 'cmd_help';
  if (isCmd(text, 'ช่วยเหลือ', 'support', 'contact_support', 'ติดต่อหนูเก็บ')) return 'cmd_support';
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
    !isCmd(text, 'ยกเลิก', 'cancel', 'ไดอารี่', 'ไดอารี่วันนี้', 'diary')
  ) {
    let captured = false;
    try {
      captured = await setDiaryCaption(app.redis, lineUserId, text.slice(0, 500));
    } catch (err) {
      app.log.warn({ err, lineUserId }, 'diary caption capture failed — treating as normal text');
    }
    if (captured) {
      await reply(event, 'จดข้อความไว้แล้วน้า ส่งรูปมาได้เลย 🌸');
      return;
    }
  }

  // Analytics: record the command INTENT (funnel top). Fire-and-forget, never
  // awaited on the 1s webhook path; unrecognized chatter classifies to null and
  // isn't logged. user_id is left null here (resolving it would add a DB hit to
  // every message) — funnels use event counts, and DAU is driven by the
  // worker-outcome + web-login events which do carry user_id.
  {
    const intent = classifyIntent(text);
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
      buttons.push({ label: 'แปลงไฟล์', text: 'หนูเก็บแปลงไฟล์' });
      buttons.push({ label: 'ไดอารี่วันนี้', text: 'หนูเก็บไดอารี่' });
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

  // Group notification toggle (group/room only). Turns the per-upload
  // "บันทึกแล้วน้า ✓" confirmation reply ON/OFF for THIS group — stored per group
  // (migration 021, group-settings.service). Open to any member (LINE's Messaging
  // API can't expose group-admin role); `updated_by` records who last changed it.
  // Reached in group/room because the "หนูเก็บ" prefix passes the bot-directed guard
  // above. In 1-on-1 it just explains the command is group-only.
  const notifyOff = isCmd(text, 'ปิดแจ้งเตือน', 'หนูเก็บปิดแจ้งเตือน');
  const notifyOn = isCmd(text, 'เปิดแจ้งเตือน', 'หนูเก็บเปิดแจ้งเตือน');
  if (notifyOff || notifyOn) {
    // Room (OpenChat) is treated like a group; both key off the group/room id.
    const groupId = source.groupId ?? source.roomId;
    if ((source.type !== 'group' && source.type !== 'room') || !groupId) {
      await reply(event, 'คำสั่งนี้ใช้ได้เฉพาะในกลุ่มน้า');
      return;
    }
    const enable = notifyOn;
    // Already in the requested state → acknowledge without a redundant write.
    const current = await getGroupNotifySetting(app.supabase, groupId);
    if (current === enable) {
      await reply(
        event,
        enable ? 'เปิดอยู่แล้วน้า ปกติเลย' : 'ปิดอยู่แล้วน้า ไม่ต้องทำอะไรเพิ่มเลย',
      );
      return;
    }
    try {
      await setGroupNotifySetting(app.supabase, groupId, enable, lineUserId);
      await reply(
        event,
        enable
          ? 'เปิดการแจ้งเตือนแล้วน้า\nหนูจะบอกทุกครั้งที่เก็บของเสร็จน้า'
          : 'ปิดการแจ้งเตือนแล้วน้า\nต่อไปหนูจะเก็บของเงียบๆ ให้น้า 🤫',
      );
    } catch (err) {
      app.log.error({ err, groupId }, 'group notify toggle failed');
      await reply(event, 'หนูเก็บ: ขอโทษนะคะ เกิดข้อผิดพลาด ลองใหม่อีกทีนะคะ 📁').catch(() => {});
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

  // Show my invite code — prefix-match on "เชิญ" (or "/invite").
  // Robust for Thai text from LINE, which may arrive with zero-width chars or a
  // non-NFC composition that broke the old exact `===` match. Strip zero-width
  // chars, normalize to NFC, then prefix-match. startsWith (not includes) so a
  // message that merely *contains* "เชิญ" (e.g. "ยกเลิกคำเชิญ", which ends in it)
  // isn't swallowed here and can fall through to its own handler. Group chats
  // never reach here: the allowlist guard at the top returns first, so bare
  // "เชิญ" only fires 1-on-1.
  const normalizedText = normalizeText(text.trim());
  const isInviteCommand =
    normalizedText.startsWith('เชิญ') || normalizedText.toLowerCase().startsWith('/invite');
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

  // ไดอารี่ 365 วัน ("หนูเก็บไดอารี่") — arms a one-shot Redis flag like
  // แปลงไฟล์: the NEXT image this user sends becomes today's diary entry
  // (optionally captioned by text typed while armed — see the capture block at
  // the top). Personal-chat only; one entry per Bangkok calendar day, checked
  // here at arm time so the user learns immediately instead of after sending a
  // photo (the worker + unique index re-check as backstops).
  if (isCmd(text, 'ไดอารี่', 'ไดอารี่วันนี้', 'diary')) {
    if (source.type === 'group' || source.type === 'room') {
      await reply(event, 'ไดอารี่ใช้ได้เฉพาะแชทส่วนตัวน้า');
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
        await replyWithQuickReply(event, 'บันทึกวันนี้แล้วนะ 🌸 มาพรุ่งนี้อีกครั้งได้เลย', [
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
      await reply(event, 'หนูเก็บ: ขอโทษนะคะ เกิดข้อผิดพลาด ลองใหม่อีกทีนะคะ 📁').catch(() => {});
    }
    return;
  }

  // Convert-to-Word ("หนูเก็บแปลงไฟล์") — arms a one-shot Redis flag; the NEXT
  // image/PDF this user sends is OCR'd (Mistral) and rebuilt as an editable
  // .docx instead of being archived as-is. Personal-chat only, like scan (a
  // shared group flag would convert other members' uploads). Feature-gated on
  // the Mistral key: without it the command explains it's unavailable.
  if (isCmd(text, 'แปลงไฟล์', 'แปลงเป็นเวิร์ด', 'word', 'เวิร์ด', 'to word')) {
    if (source.type === 'group' || source.type === 'room') {
      await reply(event, 'ระบบแปลงไฟล์ใช้ได้เฉพาะแชทส่วนตัวน้า');
      return;
    }
    if (!isMistralOcrConfigured()) {
      await reply(event, 'ระบบแปลงไฟล์ยังไม่เปิดใช้งานตอนนี้น้า รอติดตามเร็วๆ นี้เลยน้า');
      return;
    }
    await armDocxConvert(app.redis, lineUserId);
    await replyFlex(event, buildDocxConvertFlexMessage());
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
    // Reply the finalize-in-progress card HERE (fresh reply token) with a
    // "ดูล็อคเกอร์" button — this replaces the old worker-side completion PUSH.
    // The merged PDF shows up in the locker once finalize_scan finishes.
    await replyFlex(
      event,
      buildFinalizingFlexMessage({
        kind: session.session_kind ?? 'merge',
        count: pages,
        dashboardUrl: `${config.WEB_URL}/dashboard`,
      }),
    );
    return;
  }

  // Cancel merge session / convert-to-Word mode / diary mode
  if (isCmd(text, 'ยกเลิก', 'cancel')) {
    // Disarm both one-shot flags unconditionally (harmless no-ops when not armed).
    const wasArmed = await consumeDocxConvert(app.redis, lineUserId);
    const diaryWasArmed = (await consumeDiaryMode(app.redis, lineUserId)) !== null;
    if (session) {
      await cancelSession(app.supabase, session.id);
      await reply(event, 'ยกเลิกโหมดรวมรูปให้แล้วน้า รูปที่ค้างไว้หนูไม่ได้เก็บนะคะ');
    } else if (diaryWasArmed) {
      await reply(event, 'ยกเลิกโหมดไดอารี่ให้แล้วน้า');
    } else if (wasArmed) {
      await reply(event, 'ยกเลิกโหมดแปลงไฟล์ให้แล้วน้า');
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
  if (isCmd(text, 'contact_support', 'ติดต่อหนูเก็บ', 'ช่วยเหลือ', 'support')) {
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
        await reply(event, `ไฟล์ใหญ่เกิน ${mb}MB น้า ระบบแปลงไฟล์รับได้แค่นี้ก่อน ลองย่อไฟล์หรือแบ่งส่งน้า`);
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

  // An image sent while a scan session is collecting becomes a scan page.
  // 1-on-1 chats ONLY (matching where sessions can be opened): without the
  // source check, a user with an open personal scan/merge session who posts an
  // image in a GROUP would have it swallowed into their personal session
  // instead of stored in the group's shared space.
  if (message.type === 'image' && source.type === 'user') {
    const userId = await findUserId(app, lineUserId);
    const session = userId ? await getActiveSession(app.supabase, userId) : null;
    if (session) {
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
        kind: session.session_kind ?? 'merge',
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
