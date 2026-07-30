import { config } from '../config';
import type { FlexMessage } from '../services/flex.service';

/**
 * ระบบตามงาน — COMPACT help card for "หนูเก็บเตือนงาน".
 *
 * Adaptive response: the first time a group ever types the bare command it gets
 * the full instruction card (buildTaskCommandHelpCard); every time after that it
 * gets this short version instead — the group has already read the long one, and
 * repeating it turns the bot into noise. The counter lives in Redis only
 * (`nookeb:cmd_count:{groupId}:remind`) because it is pure UX state, not
 * business data; losing it just means one group re-reads the full card once.
 *
 * The "เตือนงาน" button posts back `action=remind` with
 * `inputOption: 'openKeyboard'` + a `fillInText` template, so tapping it drops
 * the command skeleton straight into the composer for the user to fill in. The
 * postback itself carries no handler — see the note in line.ts.
 *
 * NO emoji (brand rule) and BRAND_RED only, same as every other task card
 * (lineMessage.ts). The format/example lines sit in the shared light-gray "code"
 * box treatment so they read as literal text to copy.
 */

const BRAND_RED = '#B53A32';
const INK = '#111111';
const MUTED = '#8C8C8C';

const codeBox = (text: string): Record<string, unknown> => ({
  type: 'box',
  layout: 'vertical',
  backgroundColor: '#F5F5F5',
  cornerRadius: '6px',
  paddingAll: '10px',
  contents: [{ type: 'text', text, size: 'xs', color: INK, wrap: true }],
});

const label = (text: string, margin?: string): Record<string, unknown> => ({
  type: 'text',
  text,
  size: 'xxs',
  color: MUTED,
  weight: 'bold',
  ...(margin ? { margin } : {}),
});

/**
 * @param liffId  LINE_LIFF_ID — when set, "สร้างงานใหม่" deep-links into the LIFF
 *                create flow in-app; otherwise it falls back to the plain web URL.
 * @param groupId The group this card is replied into; carried as the ?groupId=
 *                capability on the create link (same contract as the full card).
 */
export function buildRemindCompactFlex(liffId?: string, groupId?: string | null): FlexMessage {
  const q = groupId ? `?groupId=${encodeURIComponent(groupId)}` : '';
  const createUri = liffId
    ? `https://liff.line.me/${liffId}/create${q}`
    : `${config.WEB_URL}/liff/tasks/create${q}`;

  return {
    type: 'flex',
    altText: 'วิธีสั่งงานในกลุ่ม (แบบย่อ)',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: BRAND_RED,
        paddingAll: '16px',
        contents: [
          {
            type: 'text',
            text: 'หนูเก็บเตือนงาน',
            weight: 'bold',
            size: 'lg',
            color: '#FFFFFF',
            wrap: true,
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#FFFFFF',
        paddingAll: '16px',
        spacing: 'sm',
        contents: [
          label('รูปแบบคำสั่ง'),
          codeBox('หนูเก็บเตือนงาน @ชื่อ [งานที่ต้องทำ] ส่ง [วัน เวลา]'),
          label('ตัวอย่าง', 'lg'),
          codeBox('หนูเก็บเตือนงาน @สมชาย ทำสไลด์นำเสนอ ส่ง 25/7 17:00'),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#FFFFFF',
        spacing: 'sm',
        paddingAll: '12px',
        contents: [
          {
            type: 'button',
            style: 'primary',
            height: 'sm',
            color: BRAND_RED,
            action: {
              type: 'postback',
              label: 'เตือนงาน',
              data: 'action=remind',
              inputOption: 'openKeyboard',
              fillInText: 'หนูเก็บเตือนงาน @ งาน.. ส่ง dd/mm 00:00',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: { type: 'uri', label: 'สร้างงานใหม่', uri: createUri },
          },
        ],
      },
    },
  };
}
