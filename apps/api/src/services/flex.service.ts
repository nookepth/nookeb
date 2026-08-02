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

import type { SessionKind } from '@nookeb/shared';
import { config } from '../config';
import { documentTypeDisplayName, formatThaiBuddhistDate, type DocumentType } from './docx-builder.service';

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN TOKENS
//
// What Flex can and cannot do — read this before "fixing" the card styling:
// there is NO CSS here. LINE renders these JSON trees natively in its own client,
// so there is no hover/active/focus state, no `disabled` attribute, no cursor, no
// entrance animation, no font-family (hence no monospace / tabular-nums), no
// box-shadow, and no control over the bubble's own corner radius. Anything in a
// design brief that needs one of those has no equivalent and must be solved a
// different way — the notes on each helper below say which way was taken.
//
// What Flex DOES give us, and what the system below is built out of: per-box
// `background` linear gradients, `backgroundColor`, `cornerRadius`, `borderWidth`
// /`borderColor`, `paddingAll`, text `size`/`weight`/`color`/`lineSpacing`/
// `letterSpacing`, 8-digit #RRGGBBAA colors, and boxes nested to any depth.
// ─────────────────────────────────────────────────────────────────────────────

// ── Neutrals ────────────────────────────────────────────────────────────────
const LINE_GREEN = '#06C755'; // reserved for COMPLETED states only (see WORKING)
const WORKING_AMBER = '#B45309'; // in-flight states — green claimed "done" while a job was still running
const BRAND_RED = '#b53a32'; // nookeb brand — locker CTA
const ERROR_RED = '#FF334B';
const INK = '#111111'; // headlines
const BODY = '#374151'; // body copy — 10.3:1 on white
const MUTED = '#6B7280'; // secondary/helper — 4.87:1 on white (was #8C8C8C = 3.36:1, failed AA)
const HAIRLINE = '#E5E7EB'; // dividers between key/value rows
const TEAL = '#0D9488'; // referral progress-bar fill (a BAR, not text — 3:1 non-text is enough)
const TEAL_TEXT = '#0F766E'; // the same teal darkened to 5.5:1 for anything that is text
const BAR_TRACK = '#EEEEEE'; // referral progress-bar background

/**
 * One accent family per card type. The rule the old cards broke: the header and
 * the CTA must come from the SAME hue — scan shipped a #1E88E5 header over a
 * #b53a32 button, and รวมไฟล์ a #1E3A5F header over a #2563EB button, so every
 * card read as two half-finished designs stapled together.
 *
 * `from`/`to` are a deliberately DARK, low-travel gradient. That is not only
 * taste: `soft` (the subtitle color) has to clear 4.5:1 against the LIGHTEST
 * point of the gradient, which caps `from`'s relative luminance at ~0.135. Every
 * pair below is checked against that — see the ratios in the comments.
 */
interface CardTheme {
  /** gradient start (top-left) — the lightest point the header ever reaches */
  from: string;
  /** gradient end (bottom-right) */
  to: string;
  /** CTA button + status accent. Always the same hue as the gradient. */
  accent: string;
  /** tinted surface for callouts/meta panels, holds `accent` text at ≥5:1 */
  tint: string;
  /** subtitle color on the header — ≥4.5:1 against `from` */
  soft: string;
  /** how many marks the header glyph draws — the non-color way to tell cards apart */
  marks: 1 | 2 | 3;
}

const THEME = {
  /** สแกน — blue. white/from 5.75:1 · soft/from 4.56:1 · white/accent 5.69:1 */
  scan: { from: '#1663C4', to: '#0D3F80', accent: '#1565C0', tint: '#EFF5FE', soft: '#DCE6F5', marks: 3 },
  /** รวมไฟล์ — indigo. Distinct from scan blue at a glance. white/from 8.1:1 */
  merge: { from: '#3A45A5', to: '#232C6B', accent: '#3A45A5', tint: '#F0F1FB', soft: '#D5D8F2', marks: 2 },
  /** แปลงไฟล์ + ผลลัพธ์ Word — teal. white/from 6.0:1 · white/accent 5.50:1 */
  convert: { from: '#0E6A63', to: '#093F3A', accent: '#0F766E', tint: '#ECF8F6', soft: '#D3EAE7', marks: 1 },
  /** อัปโหลด/ล็อคเกอร์ — brand red. Intentional: this is the nookeb brand color,
      and it is the only card family whose CTA points at the locker itself. */
  locker: { from: '#A83630', to: '#6E241F', accent: BRAND_RED, tint: '#FCF1F0', soft: '#F3D9D7', marks: 1 },
  /** ไดอารี่ — rose. Was #E85D8A, which held white at only 3.28:1 (failed AA). */
  diary: { from: '#B92457', to: '#7A1338', accent: '#C2255C', tint: '#FDF0F5', soft: '#F7DAE4', marks: 2 },
} as const satisfies Record<string, CardTheme>;

// Named shorthands for the diary section further down.
const DIARY_PINK = THEME.diary.accent;
const DIARY_PINK_SOFT = THEME.diary.tint;

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

// ─────────────────────────────────────────────────────────────────────────────
// PRIMITIVES — every card is composed from these, so a change here lands on all
// of them at once. This is the closest Flex gets to a shared stylesheet.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Status indicator: a 9px core inside a 20px tinted halo. The old flat 14px
 * square carried no weight next to `size:'sm'` text and read as a bullet rather
 * than a state. The halo is the accent at 18% alpha (#RRGGBBAA — Flex supports
 * 8-digit hex), so it tints itself from whatever color it is given.
 */
function statusDot(color: string): Record<string, unknown> {
  return {
    type: 'box',
    layout: 'vertical',
    width: '20px',
    height: '20px',
    cornerRadius: '10px',
    backgroundColor: `${color}2E`,
    justifyContent: 'center',
    alignItems: 'center',
    contents: [
      { type: 'box', layout: 'vertical', width: '9px', height: '9px', cornerRadius: '5px', backgroundColor: color, contents: [] },
    ],
  };
}

/**
 * A [dot] + text row, vertically centred (horizontal box — a baseline layout
 * cannot hold a box child). Kept at the original signature; every caller in this
 * file still passes (color, text[, textColor]).
 */
function iconRow(color: string, text: string, textColor: string = BODY): Record<string, unknown> {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    alignItems: 'center',
    contents: [
      statusDot(color),
      { type: 'text', text, size: 'sm', color: textColor, flex: 1, wrap: true, lineSpacing: '5px' },
    ],
  };
}

/**
 * The status block the brief asks for: dot + a heavy primary line + a smaller
 * muted helper line underneath, indented to hang off the dot's gutter. Use this
 * instead of {@link iconRow} whenever the row IS the card's headline.
 */
function statusBlock(color: string, title: string, hint?: string): Record<string, unknown> {
  const lines: Record<string, unknown>[] = [
    { type: 'text', text: title, weight: 'bold', size: 'md', color: INK, wrap: true, lineSpacing: '4px' },
  ];
  if (hint) lines.push({ type: 'text', text: hint, size: 'xs', color: MUTED, wrap: true, lineSpacing: '4px', margin: 'xs' });
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    contents: [
      { type: 'box', layout: 'vertical', width: '20px', contents: [statusDot(color)] },
      { type: 'box', layout: 'vertical', flex: 1, contents: lines },
    ],
  };
}

/**
 * Header glyph — 1–3 stacked white bars in a translucent rounded tile. Flex
 * `image`/`icon` render HTTPS JPEG/PNG only (see the note at the top of this
 * file), and emoji are banned by the brand rule, so an icon has to be BUILT out
 * of boxes. The bar count differs per theme, which is what makes the card types
 * distinguishable to anyone who cannot separate the hues.
 */
function headerGlyph(theme: CardTheme): Record<string, unknown> {
  const bars = Array.from({ length: theme.marks }, () => ({
    type: 'box',
    layout: 'vertical',
    height: '3px',
    cornerRadius: '2px',
    backgroundColor: '#FFFFFF',
    contents: [],
  }));
  return {
    type: 'box',
    layout: 'vertical',
    width: '30px',
    height: '30px',
    cornerRadius: '9px',
    backgroundColor: '#FFFFFF29',
    paddingAll: '8px',
    spacing: 'xs',
    justifyContent: 'center',
    contents: bars,
  };
}

/**
 * Card header: gradient surface + glyph + brand eyebrow + bold title + optional
 * subtitle. Replaces the old "one bold white word on a flat fill".
 *
 * `styles.header.backgroundColor` still has to be set by the caller to
 * `theme.to` — a LINE client too old for `background.linearGradient` falls back
 * to it, and without the fallback such a client paints the header white and the
 * white title vanishes.
 */
function cardHeader(theme: CardTheme, title: string, subtitle?: string): Record<string, unknown> {
  const text: Record<string, unknown>[] = [
    { type: 'text', text: 'หนูเก็บ', size: 'xxs', color: '#FFFFFF', weight: 'bold', letterSpacing: '2px' },
    { type: 'text', text: title, weight: 'bold', size: 'lg', color: '#FFFFFF', wrap: true, margin: 'xs' },
  ];
  if (subtitle) {
    text.push({ type: 'text', text: subtitle, size: 'xs', color: theme.soft, wrap: true, margin: 'sm', lineSpacing: '4px' });
  }
  return {
    type: 'box',
    layout: 'vertical',
    paddingAll: '18px',
    background: { type: 'linearGradient', angle: '155deg', startColor: theme.from, endColor: theme.to },
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'md',
        contents: [
          headerGlyph(theme),
          { type: 'box', layout: 'vertical', flex: 1, contents: text },
        ],
      },
    ],
  };
}

/**
 * Step rail — the honest substitute for the "spinner / progress bar" the brief
 * asks for on the in-flight cards. Flex cannot animate anything, and a fake
 * percentage would be a lie (the worker reports no progress fraction), so this
 * shows WHICH STAGE the job is at instead: filled segments behind, tinted
 * segments ahead, and the current stage named underneath.
 */
function stepRail(theme: CardTheme, labels: readonly string[], activeIndex: number): Record<string, unknown> {
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    margin: 'md',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'xs',
        contents: labels.map((_, i) => ({
          type: 'box',
          layout: 'vertical',
          height: '4px',
          flex: 1,
          cornerRadius: '2px',
          backgroundColor: i <= activeIndex ? theme.accent : `${theme.accent}24`,
          contents: [],
        })),
      },
      {
        type: 'text',
        text: `ขั้นที่ ${activeIndex + 1}/${labels.length} · ${labels[activeIndex] ?? ''}`,
        size: 'xxs',
        color: MUTED,
        wrap: true,
      },
    ],
  };
}

/**
 * Bullet list with a real hanging indent. Flex has no list component and no
 * text-indent, so the old cards packed bullets into ONE text node with "\n• " —
 * which wraps flush to the left margin and loses the indent on the second line.
 * Each bullet is its own row here, with the marker in a fixed 10px gutter.
 */
function bulletList(theme: CardTheme, items: readonly string[]): Record<string, unknown> {
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    margin: 'lg',
    contents: items.map((text) => ({
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: [
        {
          type: 'box',
          layout: 'vertical',
          width: '10px',
          contents: [
            { type: 'box', layout: 'vertical', width: '4px', height: '4px', cornerRadius: '2px', backgroundColor: theme.accent, offsetTop: '7px', contents: [] },
          ],
        },
        { type: 'text', text, size: 'sm', color: BODY, flex: 1, wrap: true, lineSpacing: '5px' },
      ],
    })),
  };
}

/** Tinted callout box — a soft `theme.tint` surface holding accent-colored text. */
function noticeBox(theme: CardTheme, text: string): Record<string, unknown> {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: theme.tint,
    cornerRadius: '12px',
    paddingAll: '12px',
    margin: 'md',
    contents: [
      { type: 'text', text, size: 'xs', color: theme.accent, weight: 'bold', wrap: true, lineSpacing: '4px' },
    ],
  };
}

/**
 * Full-width primary CTA. `height:'md'` (~52px) is deliberate — `'sm'` is ~40px
 * and misses the 44px touch-target floor that half these cards were under.
 *
 * The plain-text branch is NOT decorative: LINE rejects a `uri` action that
 * isn't https, so a dev/localhost URL has to degrade to a tappable link line or
 * the whole message fails to send.
 */
function primaryAction(theme: CardTheme, label: string, url: string): Record<string, unknown> {
  if (!url.startsWith('https://')) {
    return { type: 'text', text: `${label}: ${url}`, size: 'xs', color: theme.accent, wrap: true };
  }
  return {
    type: 'button',
    style: 'primary',
    height: 'md',
    color: theme.accent,
    action: { type: 'uri', label, uri: url },
  };
}

/**
 * Secondary "ยกเลิก" control — an OUTLINED button in the card's own accent.
 *
 * Why not `style:'secondary'`: that renders a light-gray filled slab, which is
 * also how LINE draws a de-emphasised control, so an always-enabled cancel read
 * as greyed out. Flex has no `disabled` state to distinguish it from, so the
 * only fix is to stop borrowing the disabled look. The 2px wrapper padding plus
 * the border lifts the ~40px `sm` button to ~46px of tappable height.
 *
 * The label lost its "✖": U+2716 is Extended_Pictographic, i.e. exactly what the
 * no-emoji-in-Flex-cards brand rule (and `stripEmoji`) exists to keep out.
 */
function outlineButton(theme: CardTheme, label: string, text: string): Record<string, unknown> {
  return {
    type: 'box',
    layout: 'vertical',
    cornerRadius: '12px',
    borderWidth: '1px',
    borderColor: `${theme.accent}59`,
    paddingAll: '2px',
    contents: [
      {
        type: 'button',
        style: 'link',
        height: 'sm',
        color: theme.accent,
        action: { type: 'message', label, text },
      },
    ],
  };
}

/**
 * Gray secondary "cancel" button — lets the user leave a mode at any step
 * without having to type "ยกเลิก" (sends that same trigger word as a message).
 */
function cancelButton(theme: CardTheme): Record<string, unknown> {
  return outlineButton(theme, 'ยกเลิก', 'ยกเลิก');
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
  const theme = THEME.locker;

  return {
    type: 'flex',
    altText: `หนูกำลังเก็บ ${total} ชิ้นให้อยู่น้า`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: cardHeader(theme, 'กำลังเก็บให้อยู่น้า', `รับของจากพี่ ${who} แล้ว ${total} ชิ้น`),
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '18px',
        contents: [
          // WORKING_AMBER, not LINE_GREEN: the old card showed a green dot next to
          // "หนูเก็บให้แล้วน้า" on a card whose own header says "รอสักครู่". Green is
          // the completed state everywhere else, so it was claiming a finished
          // upload while the batch was still streaming to R2.
          statusBlock(WORKING_AMBER, 'กำลังอัปโหลดเข้าล็อคเกอร์', 'แป๊บนึงน้าพี่ กดปุ่มด้านล่างดูความคืบหน้าแบบสดๆ ได้เลย'),
          stepRail(theme, ['รับไฟล์', 'อัปโหลด', 'เข้าล็อคเกอร์'], 1),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '14px',
        contents: [primaryAction(theme, 'ดูล็อคเกอร์ได้เลย', progressViewUrl)],
      },
      styles: { header: { backgroundColor: theme.to }, body: { backgroundColor: '#FFFFFF' } },
    },
  };
}

/**
 * "ระบบแปลงไฟล์" (convert-to-Word) start card — same kilo-bubble structure as
 * {@link buildPdfMergeFlexMessage} ('opened'): brand-red header title bar, bold
 * headline + muted detail body, cancel button footer. Content is the same
 * instruction text the command used to send as plain text.
 *
 * NOTE: the old brand-red "ระบบรวมรูป" card (buildMergeFlexMessage) was removed
 * when รวมรูป was consolidated into รวมไฟล์ — there is now ONE merge card,
 * {@link buildPdfMergeFlexMessage}.
 */
export function buildDocxConvertFlexMessage(): FlexMessage {
  const theme = THEME.convert;

  return {
    type: 'flex',
    altText: 'เปิดโหมดแปลงไฟล์แล้วน้า',
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: cardHeader(theme, 'ระบบแปลงไฟล์', 'รูปหรือ PDF เป็นไฟล์ Word (.docx)'),
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '18px',
        contents: [
          statusBlock(theme.accent, 'ส่งไฟล์มาได้เลยน้า', 'รับรูปภาพหรือ PDF หนูจะแปลงให้เป็น Word ที่พี่แก้ต่อได้เลย'),
          { type: 'separator', margin: 'lg', color: HAIRLINE },
          bulletList(theme, [
            'เอกสารพิมพ์ชัดๆ ถ่ายตรงๆ จะได้ผลดีที่สุดน้า',
            'ลายมือหรือรูปเบลออาจอ่านไม่ค่อยออกน้า',
          ]),
          noticeBox(theme, 'โหมดนี้ค้างไว้ 10 นาที เปลี่ยนใจกดยกเลิกด้านล่างได้เลยน้า'),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '14px',
        contents: [cancelButton(theme)],
      },
      styles: { header: { backgroundColor: theme.to }, body: { backgroundColor: '#FFFFFF' } },
    },
  };
}

/** Which "ระบบสแกน" (scan-to-PDF) card to build. Mirrors {@link PdfMergeCardVariant}. */
export type ScanCardVariant =
  | { kind: 'opened' }
  | { kind: 'page'; count: number };

/** Cancel button for the scan/merge cards — sends "หนูเก็บยกเลิก" (prefixed for group safety). */
function scanCancelButton(theme: CardTheme): Record<string, unknown> {
  return outlineButton(theme, 'ยกเลิก', 'หนูเก็บยกเลิก');
}

/**
 * Session counter — the collected page/file count as a large tabular figure over
 * its unit. Flex cannot set font-family, so true monospace/tabular-nums is off
 * the table; `letterSpacing` on an `xxl` numeral is what keeps multi-digit counts
 * from looking cramped, and the fixed-width column keeps the number's left edge
 * pinned as it grows from 1 to 20.
 */
function countTile(theme: CardTheme, count: number, unit: string): Record<string, unknown> {
  return {
    type: 'box',
    layout: 'vertical',
    width: '64px',
    backgroundColor: theme.tint,
    cornerRadius: '12px',
    paddingAll: '10px',
    justifyContent: 'center',
    contents: [
      { type: 'text', text: String(count), size: 'xxl', weight: 'bold', color: theme.accent, align: 'center', letterSpacing: '1px' },
      { type: 'text', text: unit, size: 'xxs', color: theme.accent, align: 'center' },
    ],
  };
}

/**
 * "ระบบสแกน" session cards. Separate from {@link buildPdfMergeFlexMessage}
 * ("ระบบรวมไฟล์") so a scan command never shows the merge card. Blue header, same
 * kilo-bubble structure. One builder, two variants: 'opened' (session start) and
 * 'page' (per-page confirmation).
 */
export function buildScanFlexMessage(variant: ScanCardVariant = { kind: 'opened' }): FlexMessage {
  const theme = THEME.scan;
  const styles = { header: { backgroundColor: theme.to }, body: { backgroundColor: '#FFFFFF' } };
  const footer = {
    type: 'box',
    layout: 'vertical',
    paddingAll: '14px',
    contents: [scanCancelButton(theme)],
  };

  if (variant.kind === 'page') {
    const headline = `สแกนแล้ว ${variant.count} หน้าน้า`;
    return {
      type: 'flex',
      altText: headline,
      contents: {
        type: 'bubble',
        size: 'kilo',
        header: cardHeader(theme, 'ระบบสแกน', 'กำลังเก็บหน้าเอกสาร'),
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'md',
          paddingAll: '18px',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              spacing: 'lg',
              alignItems: 'center',
              contents: [
                countTile(theme, variant.count, 'หน้า'),
                {
                  type: 'box',
                  layout: 'vertical',
                  flex: 1,
                  contents: [
                    { type: 'text', text: headline, weight: 'bold', size: 'md', color: INK, wrap: true, lineSpacing: '4px' },
                    { type: 'text', text: 'ส่งหน้าถัดไปมาได้เรื่อยๆ เลยน้า', size: 'xs', color: MUTED, wrap: true, margin: 'xs' },
                  ],
                },
              ],
            },
            stepRail(theme, ['เก็บหน้าเอกสาร', 'รวมเป็น PDF', 'เข้าล็อคเกอร์'], 0),
            noticeBox(theme, 'ครบทุกหน้าแล้วพิมพ์ "เสร็จ" ได้เลยน้า'),
          ],
        },
        footer,
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
      header: cardHeader(theme, 'ระบบสแกน', 'ถ่ายเอกสารเป็นไฟล์ PDF คมๆ'),
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '18px',
        contents: [
          statusBlock(theme.accent, 'เปิดโหมดสแกนแล้วน้า', 'ส่งรูปเอกสารมาทีละหน้าได้เลย หนูจะแต่งให้คมแล้วรวมเป็น PDF ให้'),
          stepRail(theme, ['เก็บหน้าเอกสาร', 'รวมเป็น PDF', 'เข้าล็อคเกอร์'], 0),
          noticeBox(theme, 'ครบทุกหน้าแล้วพิมพ์ "เสร็จ" ได้เลยน้า'),
        ],
      },
      footer,
      styles,
    },
  };
}

// ระบบรวมไฟล์ (migration 044; unified images+PDF) — INDIGO (THEME.merge), header
// and CTA drawn from the one family. It used to be a navy #1E3A5F header over a
// #2563EB button, two different blues that also collided with the scan card's
// blue; indigo keeps it clearly distinct from สแกน while staying cohesive itself.

/** Which "ระบบรวมไฟล์" card to build (the single, unified merge card). */
export type PdfMergeCardVariant =
  | { kind: 'opened' }
  | { kind: 'page'; count: number };

/**
 * "ระบบรวมไฟล์ PDF" session cards — same kilo-bubble structure as the merge/scan
 * cards, navy header. One builder, two variants: 'opened' (session start) and
 * 'page' (per-file confirmation). Copy says "ไฟล์" throughout, not "รูป"/"หน้า":
 * this mode takes whole PDF documents, each of which may be many pages.
 */
export function buildPdfMergeFlexMessage(
  variant: PdfMergeCardVariant = { kind: 'opened' },
): FlexMessage {
  const theme = THEME.merge;
  const styles = { header: { backgroundColor: theme.to }, body: { backgroundColor: '#FFFFFF' } };
  const footer = {
    type: 'box',
    layout: 'vertical',
    paddingAll: '14px',
    contents: [scanCancelButton(theme)],
  };

  if (variant.kind === 'page') {
    const headline = `เพิ่มไฟล์ ${variant.count} รายการแล้วน้า`;
    return {
      type: 'flex',
      altText: headline,
      contents: {
        type: 'bubble',
        size: 'kilo',
        header: cardHeader(theme, 'ระบบรวมไฟล์', 'กำลังเก็บไฟล์เข้าคิว'),
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'md',
          paddingAll: '18px',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              spacing: 'lg',
              alignItems: 'center',
              contents: [
                countTile(theme, variant.count, 'ไฟล์'),
                {
                  type: 'box',
                  layout: 'vertical',
                  flex: 1,
                  contents: [
                    { type: 'text', text: headline, weight: 'bold', size: 'md', color: INK, wrap: true, lineSpacing: '4px' },
                    { type: 'text', text: 'หนูจะรวมตามลำดับที่พี่ส่งมาน้า', size: 'xs', color: MUTED, wrap: true, margin: 'xs' },
                  ],
                },
              ],
            },
            stepRail(theme, ['เก็บไฟล์', 'รวมเป็น PDF', 'เข้าล็อคเกอร์'], 0),
            noticeBox(theme, 'ครบทุกไฟล์แล้วพิมพ์ "เสร็จ" ได้เลยน้า'),
          ],
        },
        footer,
        styles,
      },
    };
  }

  return {
    type: 'flex',
    altText: 'เปิดโหมดรวมไฟล์แล้วน้า',
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: cardHeader(theme, 'ระบบรวมไฟล์', 'รวมรูปและ PDF เป็นไฟล์เดียว'),
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '18px',
        contents: [
          statusBlock(theme.accent, 'เปิดโหมดรวมไฟล์แล้วน้า', 'รองรับทั้งรูปภาพและ PDF ส่งมาทีละอันได้เลย หนูจะรวมตามลำดับที่ส่ง'),
          stepRail(theme, ['เก็บไฟล์', 'รวมเป็น PDF', 'เข้าล็อคเกอร์'], 0),
          noticeBox(theme, 'ครบทุกไฟล์แล้วพิมพ์ "เสร็จ" ได้เลยน้า'),
        ],
      },
      footer,
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
 *   • header  — "ระบบสแกน" / "ระบบรวมไฟล์" (legacy 'merge' sessions: "ระบบรวมรูป")
 *   • body    — green-dot status line + a soft "แป๊บนึงน้าพี่" note
 *   • footer  — coral/red "ดูล็อคเกอร์ได้เลย" button → dashboard
 */
export function buildFinalizingFlexMessage(params: {
  kind: SessionKind;
  count: number;
  dashboardUrl: string;
}): FlexMessage {
  const { kind, count, dashboardUrl } = params;
  // The session's OWN theme carries through to the finalize card, so the flow
  // keeps one accent from "เปิดโหมด" to "เข้าล็อคเกอร์" instead of switching hue
  // at the last step. Legacy 'merge' sessions fall back to the locker red.
  const theme = kind === 'scan' ? THEME.scan : kind === 'pdf' ? THEME.merge : THEME.locker;
  const title =
    kind === 'scan' ? 'ระบบสแกน' : kind === 'pdf' ? 'ระบบรวมไฟล์' : 'ระบบรวมรูป';
  const statusLine =
    kind === 'scan'
      ? `หนูกำลังสแกน ${count} หน้าเป็น PDF ให้น้า`
      : `หนูกำลังรวม ${count} ไฟล์เป็น PDF ให้น้า`;
  const railLabels =
    kind === 'scan'
      ? (['เก็บหน้าเอกสาร', 'รวมเป็น PDF', 'เข้าล็อคเกอร์'] as const)
      : (['เก็บไฟล์', 'รวมเป็น PDF', 'เข้าล็อคเกอร์'] as const);

  return {
    type: 'flex',
    altText: statusLine,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: cardHeader(theme, title, 'กำลังสร้างไฟล์ให้น้า'),
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '18px',
        contents: [
          // Amber, not green — the PDF does not exist yet at this point. The old
          // card put a green (= done) dot next to "หนูกำลังสแกน…".
          statusBlock(WORKING_AMBER, statusLine, 'แป๊บนึงน้าพี่ เดี๋ยวเก็บเข้าล็อคเกอร์ให้เลยน้า'),
          stepRail(theme, railLabels, 1),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '14px',
        contents: [primaryAction(theme, 'ดูล็อคเกอร์ได้เลย', dashboardUrl)],
      },
      styles: { header: { backgroundColor: theme.to }, body: { backgroundColor: '#FFFFFF' } },
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
        color: TEAL_TEXT,
        height: 'sm',
        action: { type: 'uri', label: 'อัปโหลดเลย', uri: dashboardUrl },
      }
    : { type: 'text', text: `อัปโหลดเลย: ${dashboardUrl}`, size: 'xs', color: TEAL_TEXT, wrap: true };

  return {
    type: 'flex',
    altText: `หนูเก็บ: ได้พื้นที่เพิ่มแล้ว พื้นที่ทั้งหมดตอนนี้ ${totalGB} GB`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: TEAL_TEXT,
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
          { type: 'text', text: `+${bonusGB} GB เพิ่มเข้าบัญชีแล้ว`, size: 'sm', color: TEAL_TEXT, weight: 'bold' },
          { type: 'text', text: `พื้นที่ทั้งหมด ${totalGB} GB`, size: 'sm', color: MUTED },
        ],
      },
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: [footer] },
      styles: { header: { backgroundColor: TEAL_TEXT }, body: { backgroundColor: '#FFFFFF' } },
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
        backgroundColor: TEAL_TEXT,
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
                color: TEAL_TEXT,
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
              { type: 'text', text: `${params.referralCount} คน`, size: 'xs', color: TEAL_TEXT, weight: 'bold', align: 'end' },
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
      styles: { header: { backgroundColor: TEAL_TEXT }, body: { backgroundColor: '#FFFFFF' } },
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
  { type: 'uri', uri: `${config.WEB_URL}/dashboard` },
];

/** 8-bubble scrollable onboarding carousel (images /static/onboarding/1..8.jpg). */
export function buildOnboardingCarouselMessage(): FlexMessage {
  const bubbles = ONBOARDING_ACTIONS.map((action, i) => ({
    type: 'bubble',
    size: 'mega',
    hero: { ...ONBOARDING_HERO, url: `${config.APP_URL}/static/onboarding/${i + 1}.jpg?v=2`, action },
  }));
  return {
    type: 'flex',
    altText: 'วิธีใช้งานหนูเก็บ',
    contents: { type: 'carousel', contents: bubbles },
  };
}

/**
 * "หนูเก็บเพิ่มเติม" feature carousel (1-on-1) — a 7-bubble scrollable carousel of
 * feature-preview images (/static/onboarding/{2,3,4,5,6,7,9}.jpg), same mega/hero
 * style as the onboarding carousel. Informational only: LINE requires a valid
 * action on every bubble hero, so each carries a no-op 'หนูเก็บ' postback
 * placeholder (harmless — the server just routes it to the main menu).
 */
export function buildFeatureCarouselMessage(): FlexMessage {
  const filenames = ['2', '3', '4', '5', '6', '7', '9'];
  const bubbles = filenames.map((filename) => ({
    type: 'bubble',
    size: 'mega',
    hero: {
      ...ONBOARDING_HERO,
      // v=3: `9.jpg` used to 404 (asset didn't exist) and LINE caches by URL —
      // including the failure — so the query bump is what makes it re-fetch.
      url: `${config.APP_URL}/static/onboarding/${filename}.jpg?v=3`,
      // no-op: display-only card
      action: { type: 'uri', uri: 'https://line.me/R/' },
    },
  }));
  return {
    type: 'flex',
    altText: 'ฟีเจอร์เพิ่มเติมของหนูเก็บ',
    contents: { type: 'carousel', contents: bubbles },
  };
}

/**
 * "วิธีเริ่มใช้งานกับทีม" guide — replied to the "หนูเก็บคู่มือทีม" command / onboarding
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
    '6.  แจ้งเตือนงาน — พิมพ์ หนูเก็บเตือนงาน ได้เลย',
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

// ── หนูเก็บวิธีใช้ (Help / usage guide) ──────────────────────────────────────
// Pink-themed usage card replied to the "หนูเก็บวิธีใช้" command. Same header +
// body + footer structure as buildTeamGuideFlexMessage, but grouped into feature
// sections (section header + bullet lines) instead of numbered steps.
const HELP_PINK = '#FF6B9D';
const HELP_PINK_SOFT = '#FFF0F5';

/**
 * Full usage guide as a pink Flex card. Static content covering every current
 * หนูเก็บ feature; each section is a bold accent header followed by short bullet
 * lines. Footer points to support.
 */
export function buildHelpFlexMessage(): FlexMessage {
  const sections: { header: string; lines: string[] }[] = [
    {
      header: '📁 เก็บไฟล์',
      lines: [
        '• ส่งรูปหรือไฟล์มาในแชท → หนูเก็บให้อัตโนมัติ',
        '• พิมพ์ "หนูเก็บล็อคเกอร์" เพื่อเปิดคลังไฟล์',
      ],
    },
    {
      header: '📄 สแกน & แปลงไฟล์',
      lines: [
        '• "หนูเก็บสแกนสี" / "หนูเก็บสแกนขาวดำ" → สแกนเอกสารเป็น PDF',
        '• ส่งรูปต่อกันได้เรื่อยๆ พิมพ์ "เสร็จ" เมื่อครบ',
        '• "หนูเก็บแปลงไฟล์" → ส่งรูปหรือ PDF แปลงเป็น Word',
      ],
    },
    {
      header: '🖼️ รวมไฟล์',
      lines: [
        '• "หนูเก็บรวมไฟล์" → ส่งรูปหรือ PDF ทีละอัน พิมพ์ "เสร็จ" หนูรวมเป็นไฟล์เดียวให้',
      ],
    },
    {
      header: '📓 ไดอารี่',
      lines: [
        '• "หนูเก็บไดอารี่" → พิมพ์ข้อความ แล้วส่งรูป 1 ใบ',
        '• บันทึกได้วันละ 1 ครั้ง 365 วัน',
      ],
    },
    {
      header: '🌐 เว็บแอป',
      lines: [
        '• "หนูเก็บกล่องของขวัญ" → ส่งของขวัญให้คนพิเศษ',
        '• "หนูเก็บห้องนิรภัย" → เก็บข้อมูลสำคัญ',
        '• "หนูเก็บงานของฉัน" → ดูงานที่ได้รับมอบหมาย',
      ],
    },
    {
      header: '👥 ทีม (ใช้ในกลุ่ม)',
      lines: [
        '• "หนูเก็บเตือนงาน" → มอบหมายงานในกลุ่ม',
        '• "หนูเก็บคู่มือทีม" → วิธีเริ่มใช้งานแบบทีม',
        '• "หนูเก็บผูกทีม" → เชื่อมกลุ่มกับทีม',
      ],
    },
    {
      header: '⚙️ ทั่วไป',
      lines: [
        '• พิมพ์ "ยกเลิก" เพื่อหยุดการทำงานปัจจุบัน',
        '• พิมพ์ "หนูเก็บคำสั่ง" เพื่อดูคำสั่งทั้งหมด',
      ],
    },
  ];

  const bodyContents: Record<string, unknown>[] = [];
  sections.forEach((section, i) => {
    bodyContents.push({
      type: 'text',
      text: section.header,
      weight: 'bold',
      size: 'sm',
      color: HELP_PINK,
      wrap: true,
      margin: i === 0 ? 'none' : 'lg',
    });
    for (const line of section.lines) {
      bodyContents.push({
        type: 'text',
        text: line,
        size: 'sm',
        color: '#333333',
        wrap: true,
        margin: 'sm',
      });
    }
  });

  return {
    type: 'flex',
    altText: 'วิธีใช้หนูเก็บ',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: 'วิธีใช้หนูเก็บ', color: '#FFFFFF', weight: 'bold', size: 'lg', wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: bodyContents,
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        contents: [
          { type: 'text', text: 'ติดต่อทีมงาน → ติดต่อหนูเก็บ', size: 'xs', color: HELP_PINK, wrap: true },
        ],
      },
      styles: { header: { backgroundColor: HELP_PINK }, body: { backgroundColor: HELP_PINK_SOFT } },
    },
  };
}

/**
 * "หนูเก็บคำสั่ง" — the full command reference as a Flex card in the SAME pink
 * style as buildHelpFlexMessage (shared HELP_PINK tokens, identical header/body/
 * footer structure). Deliberately COMMAND NAMES ONLY: วิธีใช้ is the card that
 * explains what each one does, so repeating descriptions here made the two cards
 * duplicates of each other. Every entry below is a real, reachable handler in
 * handleTextCommand (webhook/line.ts) — keep the two in sync.
 */
export function buildCommandListFlexMessage(): FlexMessage {
  const sections: { header: string; commands: string[] }[] = [
    { header: '📁 ล็อคเกอร์', commands: ['หนูเก็บล็อคเกอร์'] },
    {
      header: '📄 เอกสาร',
      commands: [
        'หนูเก็บฟีเจอร์เอกสาร',
        'หนูเก็บสแกน',
        'หนูเก็บสแกนสี',
        'หนูเก็บสแกนขาวดำ',
        'หนูเก็บรวมไฟล์',
        'หนูเก็บแปลงไฟล์',
      ],
    },
    { header: '📓 ไดอารี่', commands: ['หนูเก็บไดอารี่'] },
    {
      header: '🌐 เว็บแอป',
      commands: ['หนูเก็บกล่องของขวัญ', 'หนูเก็บห้องนิรภัย', 'หนูเก็บงานของฉัน'],
    },
    {
      header: '👥 ทีม (ใช้ในกลุ่ม)',
      commands: [
        'หนูเก็บเตือนงาน',
        'หนูเก็บคู่มือทีม',
        'หนูเก็บผูกทีม',
        'หนูเก็บยกเลิกผูกทีม',
        'หนูเก็บไอดีกลุ่ม',
        'หนูเก็บลงทะเบียน',
      ],
    },
    { header: '🎁 เพื่อน', commands: ['หนูเก็บเชิญ', 'หนูเก็บกรอกโค้ด [โค้ด]'] },
    {
      header: 'ℹ️ ทั่วไป',
      commands: [
        'หนูเก็บ',
        'หนูเก็บเมนู',
        'หนูเก็บฟีเจอร์',
        'หนูเก็บวิธีใช้',
        'หนูเก็บคำสั่ง',
        'หนูเก็บแนะนำตัว',
        'หนูเก็บเพิ่มเติม',
        'ติดต่อหนูเก็บ',
      ],
    },
    { header: '⚙️ ระหว่างใช้ฟีเจอร์', commands: ['เสร็จ', 'ยกเลิก'] },
  ];

  const bodyContents: Record<string, unknown>[] = [];
  sections.forEach((section, i) => {
    bodyContents.push({
      type: 'text',
      text: section.header,
      weight: 'bold',
      size: 'sm',
      color: HELP_PINK,
      wrap: true,
      margin: i === 0 ? 'none' : 'lg',
    });
    for (const command of section.commands) {
      bodyContents.push({
        type: 'text',
        text: command,
        size: 'sm',
        color: '#333333',
        wrap: true,
        margin: 'sm',
      });
    }
  });

  return {
    type: 'flex',
    altText: 'คำสั่งทั้งหมดของหนูเก็บ',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: 'คำสั่งทั้งหมด', color: '#FFFFFF', weight: 'bold', size: 'lg', wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: bodyContents,
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        contents: [
          { type: 'text', text: 'ดูวิธีใช้แต่ละคำสั่ง → หนูเก็บวิธีใช้', size: 'xs', color: HELP_PINK, wrap: true },
        ],
      },
      styles: { header: { backgroundColor: HELP_PINK }, body: { backgroundColor: HELP_PINK_SOFT } },
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
    paddingTop: '8px',
    paddingBottom: '8px',
    contents: [
      { type: 'text', text: label, size: 'xs', color: MUTED, flex: 3, gravity: 'center' },
      // `align:'end'` + a FIXED flex ratio is the only column alignment Flex
      // offers: there is no font-family, so no monospace and no tabular figures.
      // Values still line up on their right edge, which is what makes "1.4 MB"
      // and "12.7 MB" scan as a column.
      { type: 'text', text: value, size: 'xs', color: INK, weight: 'bold', align: 'end', wrap: true, flex: 5, gravity: 'center' },
    ],
  };
}

/**
 * Key/value panel with hairline dividers BETWEEN rows (never above the first or
 * below the last — a trailing rule reads as a broken section).
 */
function metaTable(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
  const contents: Record<string, unknown>[] = [];
  rows.forEach((row, i) => {
    if (i > 0) contents.push({ type: 'separator', color: HAIRLINE });
    contents.push(row);
  });
  return { type: 'box', layout: 'vertical', margin: 'md', contents };
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
  // Same teal family as the แปลงไฟล์ START card — the result now looks like the
  // finished state of the mode the user opened, not an unrelated card. It used to
  // be a neutral slate header over a brand-red button, borrowed from the locker.
  const theme = THEME.convert;
  const subtitle = params.documentType
    ? `ประเภท: ${documentTypeDisplayName(params.documentType)}`
    : undefined;

  // Green here is correct and load-bearing: the .docx exists by the time this
  // card is built. It is the only one of these cards that has earned LINE_GREEN.
  const bodyContents: Record<string, unknown>[] = [
    statusBlock(LINE_GREEN, params.docxFilename, 'ไฟล์อยู่ในล็อคเกอร์แล้วน้า เปิดแก้ต่อได้เลย'),
  ];

  const meta: Record<string, unknown>[] = [];
  if (params.pageCount !== undefined) meta.push(metaRow('จำนวนหน้า', `${params.pageCount} หน้า`));
  if (params.fileSize !== undefined) meta.push(metaRow('ขนาดไฟล์', formatFileSize(params.fileSize)));
  if (params.convertedAt) {
    const t = params.convertedAt;
    const pad = (n: number): string => String(n).padStart(2, '0');
    const when = `${formatThaiBuddhistDate(t)} ${pad(t.getHours())}:${pad(t.getMinutes())} น.`;
    meta.push(metaRow('แปลงเมื่อ', when));
  }
  if (meta.length > 0) bodyContents.push(metaTable(meta));
  if (params.warning) {
    bodyContents.push({
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#FEF3F2',
      cornerRadius: '12px',
      paddingAll: '12px',
      margin: 'md',
      contents: [iconRow(ERROR_RED, params.warning, '#8A1C13')],
    });
  }

  return {
    type: 'flex',
    altText: 'แปลงเป็นไฟล์ Word เสร็จแล้วน้า กดดูในล็อคเกอร์ได้เลย',
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: cardHeader(theme, 'แปลงเป็น Word เสร็จแล้วน้า', subtitle),
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '18px',
        contents: bodyContents,
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '14px',
        contents: [primaryAction(theme, 'ดูล็อคเกอร์ได้เลย', params.lockerUrl)],
      },
      styles: { header: { backgroundColor: theme.to }, body: { backgroundColor: '#FFFFFF' } },
    },
  };
}

// ── ไดอารี่ 365 วัน (My Diary) ───────────────────────────────────────────────
// Rose header zone to match the diary's scrapbook aesthetic on the web
// (classic_pink template). Same kilo-bubble structure as every other card.
// DIARY_PINK / DIARY_PINK_SOFT are defined with the other tokens at the top of
// the file; the accent moved from #E85D8A to THEME.diary.accent because white
// text on #E85D8A measured 3.28:1 — under the 4.5:1 AA floor for the header
// title and well under it for the subtitle.

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
      header: cardHeader(THEME.diary, 'บันทึกไดอารี่วันนี้', params.dateThai),
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '18px',
        contents: [
          statusBlock(DIARY_PINK, 'ส่งรูปภาพวันนี้มา 1 รูป', 'หรือส่งแค่รูปเลยก็ได้นะ'),
          iconRow(TEAL_TEXT, 'อยากใส่ข้อความ พิมพ์ก่อนแล้วค่อยส่งรูปน้า'),
          noticeBox(THEME.diary, `รูปนี้จะเป็นวันที่ ${params.nextDayNumber}/365 ของไดอารี่`),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '14px',
        contents: [cancelButton(THEME.diary)],
      },
      styles: { header: { backgroundColor: THEME.diary.to }, body: { backgroundColor: '#FFFFFF' } },
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
    statusBlock(LINE_GREEN, `วันที่ ${params.dayNumber}/365 เรียบร้อย`, params.dateThai),
  ];
  const caption = stripEmoji(params.caption).trim();
  if (caption) {
    bodyContents.push({
      type: 'box',
      layout: 'vertical',
      backgroundColor: DIARY_PINK_SOFT,
      cornerRadius: '12px',
      paddingAll: '12px',
      margin: 'md',
      contents: [{ type: 'text', text: caption, size: 'sm', color: BODY, wrap: true, lineSpacing: '5px' }],
    });
  }
  return {
    type: 'flex',
    altText: `บันทึกไดอารี่แล้ว! วันที่ ${params.dayNumber}/365 เรียบร้อย`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: cardHeader(THEME.diary, 'บันทึกไดอารี่แล้วน้า', `วันที่ ${params.dayNumber} จาก 365 วัน`),
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '18px',
        contents: bodyContents,
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '14px',
        contents: [primaryAction(THEME.diary, 'ดูไดอารี่ของฉัน', params.diaryUrl)],
      },
      styles: { header: { backgroundColor: THEME.diary.to }, body: { backgroundColor: '#FFFFFF' } },
    },
  };
}
