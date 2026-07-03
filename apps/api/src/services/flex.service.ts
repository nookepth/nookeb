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
    { type: 'text', text: 'กรุณารอสักครู่', size: 'xs', color: MUTED, align: 'center' },
  ];
  // LINE requires https for uri actions — fall back to plain text in dev (http localhost)
  footerContents.push(
    progressViewUrl.startsWith('https://')
      ? {
          type: 'button',
          style: 'primary',
          color: LINE_GREEN,
          margin: 'md',
          action: { type: 'uri', label: 'ดูความคืบหน้า', uri: progressViewUrl },
        }
      : { type: 'text', text: `ดูความคืบหน้า: ${progressViewUrl}`, size: 'xs', color: LINE_GREEN, wrap: true, margin: 'md' },
  );
  return {
    type: 'flex',
    altText: `กำลังเก็บ ${total} รูป...`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [{ type: 'text', text: 'กำลังประมวลผล', weight: 'bold', size: 'lg', color: INK }],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: `รับรูปจาก ${who} แล้ว`, size: 'sm', color: '#333333', wrap: true },
          iconRow(LINE_GREEN, `กำลังเก็บ 0/${total}...`),
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
  const title = failed === 0 ? 'เก็บไฟล์สำเร็จ' : 'เก็บไฟล์เสร็จสิ้น';
  const time = new Date().toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Bangkok',
  });

  const body: Record<string, unknown>[] = [
    iconRow(LINE_GREEN, `โดย ${who}`),
    { type: 'text', text: `จำนวนไฟล์: ${total} รูป`, size: 'sm', color: '#333333' },
  ];
  if (success > 0) body.push(iconRow(LINE_GREEN, `สำเร็จ ${success} รูป`));
  if (failed > 0) body.push(iconRow(ERROR_RED, `ล้มเหลว ${failed} รูป`, ERROR_RED));

  // Short list of stored file names (max 5) — uses the `files` param
  const named = files.slice(0, 5);
  if (named.length > 0) {
    body.push({ type: 'separator', margin: 'md' });
    for (const f of named) {
      body.push({ type: 'text', text: f.filename, size: 'xs', color: MUTED, wrap: true });
    }
    if (files.length > named.length) {
      body.push({ type: 'text', text: `และอีก ${files.length - named.length} ไฟล์`, size: 'xs', color: MUTED });
    }
  }

  body.push({ type: 'separator', margin: 'md' });
  body.push({ type: 'text', text: `เวลา: ${time} น.`, size: 'xs', color: MUTED });

  // LINE requires https for uri actions — fall back to plain text in dev (http localhost)
  const footer = dashboardUrl.startsWith('https://')
    ? {
        type: 'button',
        style: 'primary',
        color: LINE_GREEN,
        height: 'sm',
        action: { type: 'uri', label: 'ดูไฟล์ในคลัง', uri: dashboardUrl },
      }
    : { type: 'text', text: `ดูไฟล์ในคลัง: ${dashboardUrl}`, size: 'xs', color: LINE_GREEN, wrap: true };

  return {
    type: 'flex',
    altText:
      failed === 0
        ? `เก็บไฟล์สำเร็จ ${success} รูป`
        : `เก็บไฟล์เสร็จสิ้น สำเร็จ ${success} ล้มเหลว ${failed}`,
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
