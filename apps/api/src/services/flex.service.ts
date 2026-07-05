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

const LINE_GREEN = '#06C755';
const BRAND_RED = '#b53a32'; // nookeb brand — CTA buttons/links
const ERROR_RED = '#FF334B';
const MUTED = '#8C8C8C';
const INK = '#111111';
const TEAL = '#0D9488'; // referral accents — invite code + progress-bar fill
const BAR_TRACK = '#EEEEEE'; // referral progress-bar background

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

/**
 * Final summary card. Sent once via pushMessage (replyToken is single-use).
 * @param params.files [{ filename, url }] of successfully stored files
 */
export function buildSummaryFlexMessage(params: {
  success: number;
  failed: number;
  files: { filename: string; url: string }[];
  dashboardUrl: string;
  username: string | null;
  /**
   * When set, render the "ระบบรวมรูป" (merge-to-PDF) completion variant instead
   * of the upload summary: brand-red header titled "ระบบรวมรูป" and a single
   * "หนูรวม N ไฟล์เป็น PDF ให้แล้วน้า" status line. Everything else (file list,
   * timestamp, dashboard button) is shared with the upload card.
   */
  merge?: { count: number };
}): FlexMessage {
  const { success, failed, files, dashboardUrl, merge } = params;
  const total = success + failed;
  const who = params.username ?? 'คุณ';
  const title = merge
    ? 'ระบบรวมรูป'
    : failed === 0
      ? 'เก็บไฟล์แย้วน้า'
      : 'ทำเสร็จแล้วน้า แต่มีนิดนึงที่ไม่ผ่าน';
  const time = new Date().toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Bangkok',
  });

  const body: Record<string, unknown>[] = merge
    ? [iconRow(LINE_GREEN, `หนูรวม ${merge.count} ไฟล์เป็น PDF ให้แล้วน้า`)]
    : [
        iconRow(LINE_GREEN, `หนูเก็บให้แล้วน้า พี่ ${who}`),
        { type: 'text', text: `ทั้งหมด ${total} ชิ้นเลยน้า`, size: 'sm', color: '#333333' },
      ];
  if (!merge && success > 0) body.push(iconRow(LINE_GREEN, `เก็บได้ ${success} ชิ้นแย้ว`));
  if (!merge && failed > 0) body.push(iconRow(ERROR_RED, `มี ${failed} ชิ้นที่ยังไม่ได้น้า`, ERROR_RED));

  // Short list of stored file names (max 5) — uses the `files` param
  const named = files.slice(0, 5);
  if (named.length > 0) {
    body.push({ type: 'separator', margin: 'md' });
    for (const f of named) {
      body.push({ type: 'text', text: f.filename, size: 'xs', color: MUTED, wrap: true });
    }
    if (files.length > named.length) {
      body.push({ type: 'text', text: `และอีก ${files.length - named.length} ไฟล์น้า`, size: 'xs', color: MUTED });
    }
  }

  body.push({ type: 'separator', margin: 'md' });
  body.push({ type: 'text', text: `เวลา ${time} น้า`, size: 'xs', color: MUTED });

  // LINE requires https for uri actions — fall back to plain text in dev (http localhost)
  const footer = dashboardUrl.startsWith('https://')
    ? {
        type: 'button',
        style: 'primary',
        color: BRAND_RED,
        height: 'sm',
        action: { type: 'uri', label: 'ไปดูล็อคเกอร์ได้เลยน้า', uri: dashboardUrl },
      }
    : { type: 'text', text: `ไปดูล็อคเกอร์ได้เลยน้า: ${dashboardUrl}`, size: 'xs', color: BRAND_RED, wrap: true };

  const altText = merge
    ? `หนูรวม ${merge.count} ไฟล์เป็น PDF ให้แล้วน้า`
    : failed === 0
      ? `เก็บไฟล์แย้วน้า ${success} ชิ้น`
      : `ทำเสร็จแล้วน้า เก็บได้ ${success} ชิ้น มี ${failed} ชิ้นที่ยังไม่ได้`;

  return {
    type: 'flex',
    altText,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [{ type: 'text', text: title, weight: 'bold', size: 'lg', color: INK }],
      },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', contents: body },
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: [footer] },
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
 * Dynamic motivational line keyed by the EXACT referral count (0–10+), matched to
 * the new 3/5/7/10 tier thresholds. The web ReferralCard keeps an identical copy
 * (getMotivationalText) — keep the two in sync when editing.
 */
export function referralMotivationalText(count: number): string {
  switch (count) {
    case 0:
      return 'เริ่มชวนเพื่อนรับรางวัลพิเศษไปเลย! 📁';
    case 1:
      return 'อีก 2 คน ได้ 3 GB เลยน้า 💛';
    case 2:
      return 'ขาดแค่คนเดียวจะได้ 3 GB แล้วววว 🔥';
    case 3:
      return 'ได้ 3 GB แล้ว! ชวนต่อได้อีกนะ อีก 2 คน ได้ 5 GB 📂';
    case 4:
      return 'อีกคนเดียว! ได้ 5 GB เลยยย 💪';
    case 5:
      return 'ได้ 5 GB แล้ว เก่งมาก! อีก 2 คน ได้ 7 GB ⭐';
    case 6:
      return 'อีกคนเดียวได้ 7 GB แล้วนะ สู้ๆ 🌟';
    case 7:
      return 'ได้ 7 GB แล้ว! ยอดเยี่ยมมาก อีก 3 คน รับ 10 GB เลย';
    case 8:
      return 'อีก 2 คน ได้ 10 GB เต็มๆ เลย! 🏆';
    case 9:
      return 'อีกคนเดียวเท่านั้น! 10 GB รออยู่นะ 👑';
    default:
      return 'เจ๋งที่สุดไปเลยย! ได้ 10 GB เต็มๆ แล้ว 🏆📁';
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
        action: { type: 'uri', label: 'อัปโหลดเลย! →', uri: dashboardUrl },
      }
    : { type: 'text', text: `อัปโหลดเลย! →: ${dashboardUrl}`, size: 'xs', color: TEAL, wrap: true };

  return {
    type: 'flex',
    altText: `หนูเก็บ: ได้พื้นที่เพิ่มแล้ว! 🎉 พื้นที่ทั้งหมดตอนนี้ ${totalGB} GB`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: TEAL,
        paddingAll: '16px',
        contents: [
          { type: 'text', text: '📁 หนูเก็บ · ได้พื้นที่เพิ่มแล้ว!', weight: 'bold', size: 'sm', color: '#FFFFFF', wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: '🎉 ยินดีด้วยนะ!', weight: 'bold', size: 'lg', color: INK },
          { type: 'text', text: `+${bonusGB} GB เพิ่มเข้าบัญชีแล้ว`, size: 'sm', color: TEAL, weight: 'bold' },
          { type: 'text', text: `พื้นที่ทั้งหมด ${totalGB} GB 📂`, size: 'sm', color: MUTED },
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
 * The 1/4/7/10 texts are exact spec'd copy; everything else gets the generic
 * progress line. Exported for the web ReferralCard teaser to reuse.
 */
export function referralMilestoneText(p: ReferralProgressParams): { title: string; line: string } {
  switch (p.referralCount) {
    case 1:
      return { title: 'หนูเก็บ: มีคนกรอกโค้ดคุณแล้วน้า! 📁', line: '3 คนแย้วน้า 🥳 อีกหน่อยได้ 3 GB แน่ๆ!' };
    case 4:
      return { title: 'หนูเก็บ: เพื่อนเยอะมากเลย! 🔥', line: '5 คนแย้วสู้ๆ 💪 ใกล้ได้ 5 GB แล้ว!' };
    case 7:
      return { title: 'หนูเก็บ: เก่งมากๆ เลยนะ! ⭐', line: '7 คนแย้วเจ๋งมาก 🌟 อีกนิดเดียว!' };
    case 10:
      return { title: 'หนูเก็บ: ทำได้สุดยอดมากเลย! 👑', line: '10 คนแย้วสุดเจ๋ง 🏆 ได้ 10 GB เต็มๆ แล้ว!' };
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

  return {
    type: 'flex',
    altText: `${milestone.title} ${milestone.line}`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: milestone.title, weight: 'bold', size: 'lg', color: INK, wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: milestone.line, weight: 'bold', size: 'md', color: INK, wrap: true },
          { type: 'text', text: `พื้นที่ตอนนี้ ${params.currentTierGB} GB 📂`, size: 'sm', color: '#333333' },
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
  const motivationalText = referralMotivationalText(params.referralCount);

  return {
    type: 'flex',
    altText: `หนูเก็บ: โค้ดชวนเพื่อนของคุณ 📁 ${params.code}`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: TEAL,
        paddingAll: '16px',
        contents: [
          { type: 'text', text: '📁 หนูเก็บ · โค้ดชวนเพื่อน', color: '#FFFFFF', size: 'sm', weight: 'bold', wrap: true },
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
