/**
 * LINE Flex Message builders — one "processing" card at batch start, one summary
 * card at batch end (replaces the per-file text spam).
 *
 * NOTE on icons: LINE Flex `image`/`icon` components only render HTTPS JPEG/PNG.
 * Inline SVG and `data:image/svg+xml` URIs are NOT supported — they show blank.
 * So the status "icons" below are native Flex colored-box components (green =
 * success, red = failure): no emoji, no external hosting, renders everywhere.
 * To use real image icons instead, host PNGs and swap `statusDot` for an
 * `{ type: 'image', url: '<https-png>' }` component.
 */

import { config } from '../config';
import { documentTypeDisplayName, formatThaiBuddhistDate, type DocumentType } from './docx-builder.service';

const LINE_GREEN = '#06C755';
const BRAND_RED = '#b53a32'; // nookeb brand — CTA buttons/links
const ERROR_RED = '#FF334B';
const MUTED = '#8C8C8C';
const INK = '#111111';
const TEAL = '#0D9488'; // referral accents — invite code + progress-bar fill
const BAR_TRACK = '#EEEEEE'; // referral progress-bar background
// Convert-to-Word result card — dark header zone. #1F2937 (slate) over pure
// #111827 (near-black): it reads as a distinct surface rather than a void, keeps
// the white title/gray subtitle legible, and pairs cleanly with the brand-red
// CTA below (near-black would fight the red and feel like an error state).
const DOCX_HEADER = '#1F2937';
const DOCX_SUBTITLE = '#D1D5DB'; // light gray subtitle on the dark header

/**
 * Strip emoji/pictographs from a string for LINE Flex text fields (Fix 5).
 * Removes Extended_Pictographic glyphs plus the variation selector (FE0F),
 * ZWJ (200D) and keycap combiner (20E3) that glue emoji sequences together.
 * Deliberately NOT `\p{Emoji}` — that class also matches ASCII digits 0-9 and
 * would corrupt text like "3 GB" / "+0.5 GB". Collapses the resulting double
 * spaces so a stripped trailing emoji doesn't leave a dangling gap.
 */
export function stripEmoji(t: string): string {
  return t
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** A LINE Flex message. `contents` is a Flex bubble object. */
export interface FlexMessage {
  type: 'flex';
  altText: string;
  contents: Record<string, unknown>;
}

/** Small filled square used as a status indicator in place of an icon glyph. */
function statusDot(color: string): Record<string, unknown> {
  return {
    type: 'box',
    layout: 'vertical',
    width: '14px',
    height: '14px',
    cornerRadius: '4px',
    backgroundColor: color,
    contents: [],
  };
}

/** A [dot] + text row, vertically centred (horizontal box — baseline can't hold a box). */
function iconRow(color: string, text: string, textColor: string = INK): Record<string, unknown> {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    alignItems: 'center',
    contents: [
      statusDot(color),
      { type: 'text', text, size: 'sm', color: textColor, flex: 1, wrap: true },
    ],
  };
}

/**
 * Gray secondary "cancel" button — lets the user leave merge mode at any step
 * without having to type "ยกเลิก" (sends that same trigger word as a message).
 */
function cancelButton(): Record<string, unknown> {
  return {
    type: 'button',
    style: 'secondary',
    height: 'sm',
    action: { type: 'message', label: 'ยกเลิก ✖', text: 'ยกเลิก' },
  };
}

/**
 * Initial "processing" card. Sent once via the first event's replyToken.
 * @param params.total           number of files in the batch
 * @param params.username        display name (null → "คุณ")
 * @param params.progressViewUrl real-time progress page (API-served)
 */
export function buildProgressFlexMessage(params: {
  total: number;
  username: string | null;
  progressViewUrl: string;
}): FlexMessage {
  const { total, progressViewUrl } = params;
  const who = params.username ?? 'คุณ';

  const footerContents: Record<string, unknown>[] = [
    { type: 'text', text: 'แป๊บนึงน้าพี่', size: 'xs', color: MUTED, align: 'center' },
  ];
  // LINE requires https for uri actions — fall back to plain text in dev (http localhost)
  footerContents.push(
    progressViewUrl.startsWith('https://')
      ? {
          type: 'button',
          style: 'primary',
          color: BRAND_RED,
          margin: 'md',
          action: { type: 'uri', label: 'ดูล็อคเกอร์ได้เลย', uri: progressViewUrl },
        }
      : { type: 'text', text: `ดูล็อคเกอร์ได้เลย: ${progressViewUrl}`, size: 'xs', color: BRAND_RED, wrap: true, margin: 'md' },
  );
  return {
    type: 'flex',
    altText: `หนูกำลังเก็บ ${total} ชิ้นให้อยู่น้า`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: 'รอสักครู่น้า หนูกำลังทำงานอยู่เลย', weight: 'bold', size: 'lg', color: INK, wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: `รับของจากพี่ ${who} แล้วน้า`, size: 'sm', color: '#333333', wrap: true },
          iconRow(LINE_GREEN, `หนูกำลังเก็บอยู่น้า 0/${total} ชิ้น`),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        contents: footerContents,
      },
      styles: { header: { backgroundColor: '#FFFFFF' }, body: { backgroundColor: '#FFFFFF' } },
    },
  };
}

/** Which "ระบบรวมรูป" (merge-to-PDF) card to build. */
export type MergeCardVariant =
  | { kind: 'opened' }
  | { kind: 'page'; count: number };

/**
 * "ระบบรวมรูป" session cards — same kilo-bubble structure as the upload cards
 * above (green header title bar, dot-row status, muted footer). One builder,
 * two variants: 'opened' (session start) and 'page' (per-page confirmation).
 */
export function buildMergeFlexMessage(variant: MergeCardVariant): FlexMessage {
  const header = {
    type: 'box',
    layout: 'vertical',
    paddingAll: '16px',
    contents: [
      { type: 'text', text: 'ระบบรวมรูป', weight: 'bold', size: 'lg', color: '#FFFFFF' },
    ],
  };
  const styles = { header: { backgroundColor: BRAND_RED }, body: { backgroundColor: '#FFFFFF' } };

  if (variant.kind === 'page') {
    const headline = `เพิ่มรูป ${variant.count} รายการแล้วน้า`;
    return {
      type: 'flex',
      altText: headline,
      contents: {
        type: 'bubble',
        size: 'kilo',
        header,
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'md',
          paddingAll: '16px',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              spacing: 'md',
              alignItems: 'center',
              contents: [
                statusDot(LINE_GREEN),
                { type: 'text', text: headline, weight: 'bold', size: 'md', color: INK, flex: 1, wrap: true },
              ],
            },
            { type: 'text', text: 'ครบทุกหน้าแล้วพิมพ์ "เสร็จ" ได้เลยน้า', size: 'sm', color: '#333333', wrap: true },
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          paddingAll: '12px',
          contents: [cancelButton()],
        },
        styles,
      },
    };
  }

  return {
    type: 'flex',
    altText: 'เปิดโหมดรวมรูปแล้วน้า',
    contents: {
      type: 'bubble',
      size: 'kilo',
      header,
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: 'เปิดโหมดรวมรูปแล้วน้า', weight: 'bold', size: 'md', color: INK, wrap: true },
          {
            type: 'text',
            text: 'ส่งรูปมาทีละหน้าได้เลยน้า ครบแล้วพิมพ์ "เสร็จ" หนูจะรวมเป็น PDF ให้',
            size: 'sm',
            color: '#333333',
            wrap: true,
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        contents: [cancelButton()],
      },
      styles,
    },
  };
}

/**
 * "ระบบแปลงไฟล์" (convert-to-Word) start card — same kilo-bubble structure as
 * {@link buildMergeFlexMessage} ('opened'): brand-red header title bar, bold
 * headline + muted detail body, cancel button footer. Content is the same
 * instruction text the command used to send as plain text.
 */
export function buildDocxConvertFlexMessage(): FlexMessage {
  const header = {
    type: 'box',
    layout: 'vertical',
    paddingAll: '16px',
    contents: [
      { type: 'text', text: 'ระบบแปลงไฟล์', weight: 'bold', size: 'lg', color: '#FFFFFF' },
    ],
  };
  const styles = { header: { backgroundColor: DOCX_HEADER }, body: { backgroundColor: '#FFFFFF' } };

  return {
    type: 'flex',
    altText: 'เปิดโหมดแปลงไฟล์แล้วน้า',
    contents: {
      type: 'bubble',
      size: 'kilo',
      header,
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        contents: [
          {
            type: 'text',
            text: 'ส่งรูปหรือไฟล์ PDF มาได้เลยน้า หนูจะแปลงเป็นไฟล์ Word (.docx) ให้',
            weight: 'bold',
            size: 'md',
            color: INK,
            wrap: true,
          },
          {
            type: 'text',
            text: '• เอกสารพิมพ์ชัดๆ ถ่ายตรงๆ จะได้ผลดีที่สุดน้า\n• ลายมือหรือรูปเบลออาจอ่านไม่ค่อยออกน้า\n• เปลี่ยนใจพิมพ์ "ยกเลิก" ได้เลย (โหมดนี้ค้างไว้ 10 นาทีน้า)',
            size: 'sm',
            color: '#333333',
            wrap: true,
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        contents: [cancelButton()],
      },
      styles,
    },
  };
}

const SCAN_BLUE = '#1E88E5'; // scan-mode card header — distinct from the merge (red) card

/** Which "ระบบสแกน" (scan-to-PDF) card to build. Mirrors {@link MergeCardVariant}. */
export type ScanCardVariant =
  | { kind: 'opened' }
  | { kind: 'page'; count: number };

/** Cancel button for the scan cards — sends "หนูเก็บยกเลิก" (prefixed for group safety). */
function scanCancelButton(): Record<string, unknown> {
  return {
    type: 'button',
    style: 'secondary',
    height: 'sm',
    action: { type: 'message', label: 'ยกเลิก ✖', text: 'หนูเก็บยกเลิก' },
  };
}

/**
 * "ระบบสแกน" session cards. Separate from {@link buildMergeFlexMessage}
 * ("ระบบรวมรูป") so a scan command never shows the merge card. Blue header, same
 * kilo-bubble structure. One builder, two variants: 'opened' (session start) and
 * 'page' (per-page confirmation).
 */
export function buildScanFlexMessage(variant: ScanCardVariant = { kind: 'opened' }): FlexMessage {
  const header = {
    type: 'box',
    layout: 'vertical',
    paddingAll: '16px',
    contents: [{ type: 'text', text: 'ระบบสแกน', weight: 'bold', size: 'lg', color: '#FFFFFF' }],
  };
  const styles = { header: { backgroundColor: SCAN_BLUE }, body: { backgroundColor: '#FFFFFF' } };

  if (variant.kind === 'page') {
    const headline = `สแกนแล้ว ${variant.count} หน้าน้า`;
    return {
      type: 'flex',
      altText: headline,
      contents: {
        type: 'bubble',
        size: 'kilo',
        header,
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'md',
          paddingAll: '16px',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              spacing: 'md',
              alignItems: 'center',
              contents: [
                statusDot(LINE_GREEN),
                { type: 'text', text: headline, weight: 'bold', size: 'md', color: INK, flex: 1, wrap: true },
              ],
            },
            { type: 'text', text: 'ครบทุกหน้าแล้วพิมพ์ "เสร็จ" ได้เลยน้า', size: 'sm', color: '#333333', wrap: true },
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          paddingAll: '12px',
          contents: [scanCancelButton()],
        },
        styles,
      },
    };
  }

  return {
    type: 'flex',
    altText: 'เปิดโหมดสแกนเอกสารแล้วน้า',
    contents: {
      type: 'bubble',
      size: 'kilo',
      header,
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: 'เปิดโหมดสแกนเอกสารแล้วน้า', weight: 'bold', size: 'md', color: INK, wrap: true },
          {
            type: 'text',
            text: 'ส่งรูปเอกสารมาได้เลย หนูจะสแกนและแปลงเป็น PDF ให้น้า ครบแล้วพิมพ์ "เสร็จ"',
            size: 'sm',
            color: '#333333',
            wrap: true,
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        contents: [scanCancelButton()],
      },
      styles,
    },
  };
}

/**
 * Finalize-in-progress card — replied at "เสร็จ" (the moment the user asks to
 * build the PDF), replacing the old worker-side completion PUSH. The reply token
 * is fresh here, so this always lands for free; the merged PDF then appears in the
 * locker (the button target). One compact kilo bubble, same header colors as the
 * scan (blue) / merge (red) session cards:
 *   • header  — "ระบบสแกน" / "ระบบรวมรูป"
 *   • body    — green-dot status line + a soft "แป๊บนึงน้าพี่" note
 *   • footer  — coral/red "ดูล็อคเกอร์ได้เลย" button → dashboard
 */
export function buildFinalizingFlexMessage(params: {
  kind: 'scan' | 'merge';
  count: number;
  dashboardUrl: string;
}): FlexMessage {
  const { kind, count, dashboardUrl } = params;
  const headerColor = kind === 'scan' ? SCAN_BLUE : BRAND_RED;
  const title = kind === 'scan' ? 'ระบบสแกน' : 'ระบบรวมรูป';
  const statusLine =
    kind === 'scan'
      ? `หนูกำลังสแกน ${count} หน้าเป็น PDF ให้น้า`
      : `หนูกำลังรวม ${count} ไฟล์เป็น PDF ให้น้า`;

  // LINE requires https for uri actions — fall back to plain text in dev (http localhost)
  const footer = dashboardUrl.startsWith('https://')
    ? {
        type: 'button',
        style: 'primary',
        color: BRAND_RED,
        height: 'sm',
        action: { type: 'uri', label: 'ดูล็อคเกอร์ได้เลย', uri: dashboardUrl },
      }
    : { type: 'text', text: `ดูล็อคเกอร์ได้เลย: ${dashboardUrl}`, size: 'xs', color: BRAND_RED, wrap: true };

  return {
    type: 'flex',
    altText: statusLine,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [{ type: 'text', text: title, weight: 'bold', size: 'lg', color: '#FFFFFF' }],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        contents: [
          iconRow(LINE_GREEN, statusLine),
          { type: 'text', text: 'แป๊บนึงน้าพี่ เดี๋ยวเก็บเข้าล็อคเกอร์ให้เลยน้า', size: 'xs', color: MUTED, wrap: true },
        ],
      },
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: [footer] },
      styles: { header: { backgroundColor: headerColor }, body: { backgroundColor: '#FFFFFF' } },
    },
  };
}

/** Teal-on-gray progress bar (referral tier progress). Percent is clamped 0–100. */
function progressBar(percent: number): Record<string, unknown> {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return {
    type: 'box',
    layout: 'vertical',
    height: '8px',
    cornerRadius: '4px',
    backgroundColor: BAR_TRACK,
    margin: 'md',
    contents:
      clamped > 0
        ? [
            {
              type: 'box',
              layout: 'vertical',
              width: `${clamped}%`,
              height: '8px',
              cornerRadius: '4px',
              backgroundColor: TEAL,
              contents: [],
            },
          ]
        : [],
  };
}

/**
 * Dynamic motivational line keyed by the EXACT referral count, matched to the
 * 3/5 tier thresholds (migration 030). The web ReferralCard keeps an identical
 * copy (getMotivationalText) — keep the two in sync when editing.
 * 5 is the top tier, so everything past it shares the default line.
 */
export function referralMotivationalText(count: number): string {
  switch (count) {
    case 0:
      return 'เริ่มชวนเพื่อนรับรางวัลพิเศษไปเลย! ❤️';
    case 1:
      return 'อีก 2 คน ได้ 2.5 GB เลยน้า ❤️';
    case 2:
      return 'ขาดแค่คนเดียวจะได้ 2.5 GB แล้วววว 🔥';
    case 3:
      return 'ได้ 2.5 GB แล้ว! ชวนต่อได้อีกนะ อีก 2 คน ได้ 4 GB 📂';
    case 4:
      return 'อีกคนเดียว! ได้ 4 GB เลยยย 💪';
    default:
      return 'เจ๋งที่สุดไปเลยย! ได้ 4 GB เต็มๆ แล้ว 🏆📁';
  }
}

/**
 * Pushed to the referee right after they successfully redeem a referral code.
 * Compact teal-header card — clean, minimal, on-brand.
 * @param params.totalGB new total storage after the bonus (already in GB)
 * @param params.bonusGB the one-time bonus that was just granted (GB)
 */
export function buildRedeemSuccessFlexMessage(params: {
  totalGB: number;
  bonusGB: number;
  dashboardUrl: string;
}): FlexMessage {
  const { totalGB, bonusGB, dashboardUrl } = params;

  // LINE requires https for uri actions — fall back to plain text in dev (http localhost)
  const footer = dashboardUrl.startsWith('https://')
    ? {
        type: 'button',
        style: 'primary',
        color: TEAL,
        height: 'sm',
        action: { type: 'uri', label: 'อัปโหลดเลย', uri: dashboardUrl },
      }
    : { type: 'text', text: `อัปโหลดเลย: ${dashboardUrl}`, size: 'xs', color: TEAL, wrap: true };

  return {
    type: 'flex',
    altText: `หนูเก็บ: ได้พื้นที่เพิ่มแล้ว พื้นที่ทั้งหมดตอนนี้ ${totalGB} GB`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: TEAL,
        paddingAll: '16px',
        contents: [
          { type: 'text', text: 'หนูเก็บ · ได้พื้นที่เพิ่มแล้ว', weight: 'bold', size: 'sm', color: '#FFFFFF', wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: 'ยินดีด้วยนะ!', weight: 'bold', size: 'lg', color: INK },
          { type: 'text', text: `+${bonusGB} GB เพิ่มเข้าบัญชีแล้ว`, size: 'sm', color: TEAL, weight: 'bold' },
          { type: 'text', text: `พื้นที่ทั้งหมด ${totalGB} GB`, size: 'sm', color: MUTED },
        ],
      },
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: [footer] },
      styles: { header: { backgroundColor: TEAL }, body: { backgroundColor: '#FFFFFF' } },
    },
  };
}

/** Referral progress snapshot the referrer cards render (matches getReferralStatus). */
export interface ReferralProgressParams {
  referralCount: number;
  currentTierGB: number;
  nextTierGB: number | null;
  neededForNext: number;
  progressPercent: number;
}

/**
 * Milestone copy per referral count — title (with "หนูเก็บ: " prefix) + body line.
 * Keyed to the 3/5 ladder (migration 030): 1 and 4 are the "one/two more to go"
 * nudges, 5 is the top tier. Everything else (including counts past 5, which keep
 * rising with no further grant) gets the generic progress line.
 * Exported for the web ReferralCard teaser to reuse.
 */
export function referralMilestoneText(p: ReferralProgressParams): { title: string; line: string } {
  switch (p.referralCount) {
    case 1:
      return { title: 'หนูเก็บ: มีคนกรอกโค้ดคุณแล้วน้า! 📁', line: '1 คนแย้วน้า 🥳 อีก 2 คน ได้ 2.5 GB แน่ๆ!' };
    case 4:
      return { title: 'หนูเก็บ: เพื่อนเยอะมากเลย! 🔥', line: '4 คนแย้วสู้ๆ 💪 อีกคนเดียวได้ 4 GB แล้ว!' };
    case 5:
      return { title: 'หนูเก็บ: ทำได้สุดยอดมากเลย! 👑', line: '5 คนแย้วสุดเจ๋ง 🏆 ได้ 4 GB เต็มๆ แล้ว!' };
    default:
      return {
        title: `หนูเก็บ: ${p.referralCount} คนกรอกโค้ดของคุณแล้วนะ 💛`,
        line:
          p.nextTierGB !== null
            ? `อีก ${p.neededForNext} คน ได้ ${p.nextTierGB} GB เพิ่มเลย!`
            : 'สุดยอดไปเลยน้า ได้พื้นที่เต็มแล้ว 🏆',
      };
  }
}

/** Pushed to the referrer each time someone redeems their code. */
export function buildReferralProgressFlexMessage(params: ReferralProgressParams): FlexMessage {
  const milestone = referralMilestoneText(params);
  // Fix 5 — strip emoji from every text field before it goes into the LINE card.
  const title = stripEmoji(milestone.title);
  const line = stripEmoji(milestone.line);
  const tierLine = stripEmoji(`พื้นที่ตอนนี้ ${params.currentTierGB} GB`);

  return {
    type: 'flex',
    altText: `${title} ${line}`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: title, weight: 'bold', size: 'lg', color: INK, wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: line, weight: 'bold', size: 'md', color: INK, wrap: true },
          { type: 'text', text: tierLine, size: 'sm', color: '#333333' },
          progressBar(params.progressPercent),
        ],
      },
      styles: { header: { backgroundColor: '#FFFFFF' }, body: { backgroundColor: '#FFFFFF' } },
    },
  };
}

/** Invite-code card — replied when the user asks for their code ("เชิญ" / "/invite").
 * Compact teal-header design: big code block, one stat row, one motivational hint.
 * The footer tells the RECIPIENT exactly what to type to redeem the code.
 * NOTE: LINE Flex can't set font-family, so the code renders as bold xxl teal
 * instead of true monospace — real monospace only exists on the web ReferralCard. */
export function buildInviteFlexMessage(params: ReferralProgressParams & { code: string }): FlexMessage {
  // Fix 5 — strip emoji from the motivational line before it enters the card.
  const motivationalText = stripEmoji(referralMotivationalText(params.referralCount));

  return {
    type: 'flex',
    altText: `หนูเก็บ: โค้ดชวนเพื่อนของคุณ ${params.code}`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: TEAL,
        paddingAll: '16px',
        contents: [
          { type: 'text', text: 'หนูเก็บ · โค้ดชวนเพื่อน', color: '#FFFFFF', size: 'sm', weight: 'bold', wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        contents: [
          // Big code display
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#F0FDFA',
            cornerRadius: '8px',
            paddingAll: '12px',
            contents: [
              {
                type: 'text',
                text: params.code,
                size: 'xxl',
                weight: 'bold',
                color: TEAL,
                align: 'center',
                letterSpacing: '4px',
              },
            ],
          },
          // Stats row
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: 'เชิญแล้ว', size: 'xs', color: '#6B7280', flex: 1 },
              { type: 'text', text: `${params.referralCount} คน`, size: 'xs', color: TEAL, weight: 'bold', align: 'end' },
            ],
          },
          // Progress hint
          { type: 'text', text: motivationalText, size: 'xs', color: '#374151', wrap: true },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        contents: [
          {
            type: 'text',
            text: `พิมพ์ว่า 'กรอกโค้ด ${params.code}' เพื่อรับพื้นที่เพิ่ม`,
            size: 'xs',
            color: '#6B7280',
            wrap: true,
            align: 'center',
          },
        ],
      },
      styles: { header: { backgroundColor: TEAL }, body: { backgroundColor: '#FFFFFF' } },
    },
  };
}

// ── Onboarding (follow/join) ────────────────────────────────────────────────
// Sent on onboarding when a user adds the bot (follow) or it's added to a group
// (join): a 7-bubble scrollable carousel (paired with a plain welcome image sent
// from webhook/line.ts). Hero images are public R2 static assets
// (routes/static.ts → /static/...),
// APP_URL-derived so they resolve to the deployed API per environment. LINE
// fetches these hero URLs directly, so they must be permanent public HTTPS URLs.

/** Shared hero-image props for every onboarding bubble (full-width, 1:1 fit on white). */
const ONBOARDING_HERO = { type: 'image', size: 'full', aspectRatio: '1:1', aspectMode: 'fit', backgroundColor: '#FFFFFF' } as const;

/**
 * Per-bubble tap action for the onboarding carousel (index 0 = 1.jpg … 7 = 8.jpg).
 * LINE requires a valid action on every bubble hero, so bubbles without a real
 * action yet use a `postback` with data 'หนูเก็บ' as a safe placeholder (routed by
 * the postback handler in webhook/line.ts → handleTextCommand); the last bubble
 * (index 7) opens the web dashboard via a `uri` action.
 */
const ONBOARDING_ACTIONS: readonly Record<string, unknown>[] = [
  { type: 'postback', data: 'หนูเก็บ' },
  { type: 'postback', data: 'หนูเก็บ' }, // TODO: replace with real action
  { type: 'postback', data: 'หนูเก็บ' }, // TODO: replace with real action
  { type: 'postback', data: 'หนูเก็บ' }, // TODO: replace with real action
  { type: 'postback', data: 'หนูเก็บ' }, // TODO: replace with real action
  { type: 'postback', data: 'หนูเก็บ' }, // TODO: replace with real action
  { type: 'postback', data: 'หนูเก็บ' }, // TODO: replace with real action
  { type: 'uri', uri: `${config.APP_URL}/dashboard` },
];

/** 8-bubble scrollable onboarding carousel (images /static/onboarding/1..8.jpg). */
export function buildOnboardingCarouselMessage(): FlexMessage {
  const bubbles = ONBOARDING_ACTIONS.map((action, i) => ({
    type: 'bubble',
    size: 'mega',
    hero: { ...ONBOARDING_HERO, url: `${config.APP_URL}/static/onboarding/${i + 1}.jpg`, action },
  }));
  return {
    type: 'flex',
    altText: 'วิธีใช้งานหนูเก็บ',
    contents: { type: 'carousel', contents: bubbles },
  };
}

/**
 * "วิธีเริ่มใช้งานกับทีม" guide — replied to the "หนูเก็บทีม" command / onboarding
 * carousel bubble-5 postback. Brand-red header (BRAND_RED, the same red the merge
 * card uses), 5 numbered steps, muted footer. No emoji (parity with the other
 * cards). Static content, so no params.
 */
export function buildTeamGuideFlexMessage(): FlexMessage {
  const steps = [
    '1.  เพิ่มหนูเก็บเข้ากลุ่ม',
    '2.  สร้างทีมในแดชบอร์ด',
    '3.  เข้าร่วมทีม',
    '4.  ผูกทีมกับไลน์กลุ่ม  (พิมพ์ หนูเก็บผูกทีม ได้เลย)',
    '5.  เริ่มส่งรูปแล้วเก็บความทรงจำได้เลยยย',
  ];
  return {
    type: 'flex',
    altText: 'วิธีสร้างทีมกับหนูเก็บ',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: 'วิธีเริ่มใช้งานกับทีม', color: '#FFFFFF', weight: 'bold', size: 'lg', wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: steps.map((text) => ({
          type: 'text',
          text,
          wrap: true,
          size: 'sm',
          color: '#333333',
          margin: 'md',
        })),
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        contents: [
          { type: 'text', text: 'มีปัญหา? พิมพ์ หนูเก็บ เพื่อดูเมนูหลัก', size: 'xs', color: '#AAAAAA', wrap: true },
        ],
      },
      styles: { header: { backgroundColor: BRAND_RED }, body: { backgroundColor: '#FFFFFF' } },
    },
  };
}

/** Human-readable file size (B / KB / MB) for the convert result card. */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** "label ……… value" meta row (muted label left, ink value right-aligned). */
function metaRow(label: string, value: string): Record<string, unknown> {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'xs', color: MUTED, flex: 3 },
      { type: 'text', text: value, size: 'xs', color: '#333333', align: 'end', wrap: true, flex: 5 },
    ],
  };
}

/**
 * Convert-to-Word result card (convert_to_docx worker push). Dark header zone
 * (white title + gray "ประเภท: …" subtitle from the detected document type),
 * white body with the .docx filename, page count, file size and Thai converted
 * date/time, and the brand-red "ดูล็อคเกอร์ได้เลย" locker button (same target/
 * label as the upload progress card). All fields except docxFilename/lockerUrl
 * are optional so the retry-recovery path (which only knows the stored name) and
 * missing-size cases degrade gracefully. `warning` adds a muted caution row.
 */
export function buildConvertToDocxResultCard(params: {
  docxFilename: string;
  lockerUrl: string;
  originalFilename?: string;
  documentType?: DocumentType;
  fileSize?: number;
  pageCount?: number;
  convertedAt?: Date;
  warning?: string;
}): FlexMessage {
  const headerContents: Record<string, unknown>[] = [
    { type: 'text', text: 'แปลงเป็น Word เสร็จแล้วน้า', weight: 'bold', size: 'lg', color: '#FFFFFF', wrap: true },
  ];
  if (params.documentType) {
    headerContents.push({
      type: 'text',
      text: `ประเภท: ${documentTypeDisplayName(params.documentType)}`,
      size: 'xs',
      color: DOCX_SUBTITLE,
      wrap: true,
    });
  }

  const bodyContents: Record<string, unknown>[] = [iconRow(LINE_GREEN, params.docxFilename)];
  const meta: Record<string, unknown>[] = [];
  if (params.pageCount !== undefined) meta.push(metaRow('จำนวนหน้า', `${params.pageCount} หน้า`));
  if (params.fileSize !== undefined) meta.push(metaRow('ขนาดไฟล์', formatFileSize(params.fileSize)));
  if (params.convertedAt) {
    const t = params.convertedAt;
    const pad = (n: number): string => String(n).padStart(2, '0');
    const when = `${formatThaiBuddhistDate(t)} ${pad(t.getHours())}:${pad(t.getMinutes())} น.`;
    meta.push(metaRow('แปลงเมื่อ', when));
  }
  if (meta.length > 0) {
    bodyContents.push({ type: 'separator', margin: 'md', color: BAR_TRACK });
    bodyContents.push(...meta);
  }
  if (params.warning) bodyContents.push(iconRow(ERROR_RED, params.warning, MUTED));

  return {
    type: 'flex',
    altText: 'แปลงเป็นไฟล์ Word เสร็จแล้วน้า กดดูในล็อคเกอร์ได้เลย',
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        backgroundColor: DOCX_HEADER,
        paddingAll: '16px',
        contents: headerContents,
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '16px',
        contents: bodyContents,
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        contents: [
          params.lockerUrl.startsWith('https://')
            ? {
                type: 'button',
                style: 'primary',
                color: BRAND_RED,
                action: { type: 'uri', label: 'ดูล็อคเกอร์ได้เลย', uri: params.lockerUrl },
              }
            : { type: 'text', text: `ดูล็อคเกอร์ได้เลย: ${params.lockerUrl}`, size: 'xs', color: BRAND_RED, wrap: true },
        ],
      },
      styles: { header: { backgroundColor: DOCX_HEADER }, body: { backgroundColor: '#FFFFFF' } },
    },
  };
}

// ── ไดอารี่ 365 วัน (My Diary) ───────────────────────────────────────────────
// Pink header zone to match the diary's scrapbook aesthetic on the web
// (classic_pink template). Same kilo-bubble structure as every other card.
const DIARY_PINK = '#E85D8A';
const DIARY_PINK_SOFT = '#FDF0F5';

/**
 * Diary prompt card — replied when "ไดอารี่" arms diary mode. Explains the
 * one-shot flow (optional caption text first, then ONE photo) and carries a
 * cancel button that sends the shared "ยกเลิก" trigger.
 */
export function buildDiaryPromptCard(params: {
  /** Thai Buddhist date of today (Bangkok) */
  dateThai: string;
  /** the day number this entry will get, "วันที่ X/365" */
  nextDayNumber: number;
}): FlexMessage {
  return {
    type: 'flex',
    altText: `บันทึกไดอารี่วันที่ ${params.dateThai} — ส่งรูป 1 รูปมาได้เลยน้า`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        backgroundColor: DIARY_PINK,
        paddingAll: '16px',
        contents: [
          { type: 'text', text: 'บันทึกไดอารี่วันนี้', weight: 'bold', size: 'lg', color: '#FFFFFF', wrap: true },
          { type: 'text', text: params.dateThai, size: 'xs', color: '#FCE7F0', wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        contents: [
          iconRow(DIARY_PINK, 'ส่งรูปภาพวันนี้มา 1 รูป'),
          iconRow(TEAL, 'อยากใส่ข้อความ พิมพ์ก่อนแล้วค่อยส่งรูปน้า'),
          { type: 'text', text: 'หรือส่งแค่รูปเลยก็ได้นะ', size: 'sm', color: '#333333', wrap: true },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: DIARY_PINK_SOFT,
            cornerRadius: '8px',
            paddingAll: '10px',
            contents: [
              {
                type: 'text',
                text: `รูปนี้จะเป็นวันที่ ${params.nextDayNumber}/365 ของไดอารี่`,
                size: 'xs',
                color: DIARY_PINK,
                weight: 'bold',
                align: 'center',
                wrap: true,
              },
            ],
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        contents: [cancelButton()],
      },
      styles: { header: { backgroundColor: DIARY_PINK }, body: { backgroundColor: '#FFFFFF' } },
    },
  };
}

/**
 * Diary result card (create_diary_entry worker). "บันทึกแล้ว! วันที่ X/365"
 * plus the caption (when any) and a button to the My Diary dashboard.
 */
export function buildDiaryResultCard(params: {
  dayNumber: number;
  dateThai: string;
  caption: string;
  diaryUrl: string;
}): FlexMessage {
  const bodyContents: Record<string, unknown>[] = [
    iconRow(LINE_GREEN, `วันที่ ${params.dayNumber}/365 เรียบร้อย`),
    { type: 'text', text: params.dateThai, size: 'xs', color: MUTED },
  ];
  const caption = stripEmoji(params.caption).trim();
  if (caption) {
    bodyContents.push({
      type: 'box',
      layout: 'vertical',
      backgroundColor: DIARY_PINK_SOFT,
      cornerRadius: '8px',
      paddingAll: '10px',
      margin: 'sm',
      contents: [{ type: 'text', text: caption, size: 'sm', color: '#4B5563', wrap: true }],
    });
  }
  return {
    type: 'flex',
    altText: `บันทึกไดอารี่แล้ว! วันที่ ${params.dayNumber}/365 เรียบร้อย`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: DIARY_PINK,
        paddingAll: '16px',
        contents: [
          { type: 'text', text: 'บันทึกไดอารี่แล้วน้า', weight: 'bold', size: 'lg', color: '#FFFFFF', wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '16px',
        contents: bodyContents,
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        contents: [
          params.diaryUrl.startsWith('https://')
            ? {
                type: 'button',
                style: 'primary',
                color: DIARY_PINK,
                action: { type: 'uri', label: 'ดูไดอารี่ของฉัน', uri: params.diaryUrl },
              }
            : { type: 'text', text: `ดูไดอารี่ของฉัน: ${params.diaryUrl}`, size: 'xs', color: DIARY_PINK, wrap: true },
        ],
      },
      styles: { header: { backgroundColor: DIARY_PINK }, body: { backgroundColor: '#FFFFFF' } },
    },
  };
}
