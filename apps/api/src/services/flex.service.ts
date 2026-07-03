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
          action: { type: 'uri', label: 'ดูคลังสมบัติได้เลย', uri: progressViewUrl },
        }
      : { type: 'text', text: `ดูคลังสมบัติได้เลย: ${progressViewUrl}`, size: 'xs', color: BRAND_RED, wrap: true, margin: 'md' },
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
}): FlexMessage {
  const { success, failed, files, dashboardUrl } = params;
  const total = success + failed;
  const who = params.username ?? 'คุณ';
  const title = failed === 0 ? 'เก็บไฟล์แย้วน้า' : 'ทำเสร็จแล้วน้า แต่มีนิดนึงที่ไม่ผ่าน';
  const time = new Date().toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Bangkok',
  });

  const body: Record<string, unknown>[] = [
    iconRow(LINE_GREEN, `หนูเก็บให้แล้วน้า พี่ ${who}`),
    { type: 'text', text: `ทั้งหมด ${total} ชิ้นเลยน้า`, size: 'sm', color: '#333333' },
  ];
  if (success > 0) body.push(iconRow(LINE_GREEN, `เก็บได้ ${success} ชิ้นแย้ว`));
  if (failed > 0) body.push(iconRow(ERROR_RED, `มี ${failed} ชิ้นที่ยังไม่ได้น้า`, ERROR_RED));

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
        action: { type: 'uri', label: 'ไปดูคลังสมบัติได้เลยน้า', uri: dashboardUrl },
      }
    : { type: 'text', text: `ไปดูคลังสมบัติได้เลยน้า: ${dashboardUrl}`, size: 'xs', color: BRAND_RED, wrap: true };

  return {
    type: 'flex',
    altText:
      failed === 0
        ? `เก็บไฟล์แย้วน้า ${success} ชิ้น`
        : `ทำเสร็จแล้วน้า เก็บได้ ${success} ชิ้น มี ${failed} ชิ้นที่ยังไม่ได้`,
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

/** Which "ระบบรวมไฟล์" (merge-to-PDF) card to build. */
export type MergeCardVariant =
  | { kind: 'opened' }
  | { kind: 'page'; pageNo: number };

/**
 * "ระบบรวมไฟล์" session cards — same kilo-bubble structure as the upload cards
 * above (green header title bar, dot-row status, muted footer). One builder,
 * two variants: 'opened' (session start) and 'page' (per-page confirmation).
 */
export function buildMergeFlexMessage(variant: MergeCardVariant): FlexMessage {
  const header = {
    type: 'box',
    layout: 'vertical',
    paddingAll: '16px',
    contents: [
      { type: 'text', text: 'ระบบรวมไฟล์', weight: 'bold', size: 'lg', color: '#FFFFFF' },
    ],
  };
  const styles = { header: { backgroundColor: LINE_GREEN }, body: { backgroundColor: '#FFFFFF' } };

  if (variant.kind === 'page') {
    const headline = `เพิ่มไฟล์ที่ ${variant.pageNo} แล้วน้า`;
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
      header,
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: 'เปิดโหมดรวมไฟล์แล้วน้า', weight: 'bold', size: 'md', color: INK, wrap: true },
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
        contents: [
          { type: 'text', text: '(พิมพ์ "ยกเลิก" ถ้าไม่เอาแล้วน้า)', size: 'xs', color: MUTED, wrap: true },
        ],
      },
      styles,
    },
  };
}
