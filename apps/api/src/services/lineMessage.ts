import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import type { RemindType, TaskAssigneeRecord } from '@nookeb/shared';
import { config } from '../config';
import type { FlexMessage } from './flex.service';
import type { TaskItemWithAssignees, TaskWithDetails } from './task.service';
import { effectiveDeadline } from './task.service';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * ระบบตามงาน LINE message builders. Same Flex conventions as flex.service.ts:
 * NO emoji anywhere (brand rule — status/urgency indicators are native colored
 * boxes, LINE Flex can't render SVG/data-URIs), Thai copy in the หนูเก็บ voice.
 *
 * These messages are PUSHED (the task feature's sanctioned push exception —
 * see line.service.ts): announcements fire from a LIFF submit, reminders from
 * the BullMQ timer; neither has a replyToken.
 */

// Brand palette — same tokens as flex.service.ts. Task cards use ONLY these
// (plus the semantic urgency ramp on reminder cards below).
const BRAND_RED = '#B53A32';
const LINE_GREEN = '#06C755';
const INK = '#111111';
const MUTED = '#8C8C8C';

const URGENCY_COLOR: Record<RemindType, string> = {
  '3_days': LINE_GREEN,
  '1_day': '#FF9800',
  '3_hours': '#FF5722',
  overdue: '#F44336',
};

const URGENCY_LABEL: Record<RemindType, string> = {
  '3_days': 'อีก 3 วันถึงกำหนด',
  '1_day': 'พรุ่งนี้ถึงกำหนดแล้ว',
  '3_hours': 'อีก 3 ชั่วโมงถึงกำหนด',
  overdue: 'เลยกำหนดแล้ว',
};

const TYPE_LABEL: Record<string, string> = {
  single: 'งานเดียว',
  multi: 'แยกรายการ',
  recurring: 'งานประจำ',
};

const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

/** "20 ก.ค. 14:30" on the Bangkok wall clock. */
export function formatThaiDeadline(iso: string): string {
  const d = dayjs(iso).tz('Asia/Bangkok');
  return `${d.date()} ${THAI_MONTHS[d.month()]} ${d.format('HH:mm')}`;
}

/** LIFF deep link when LINE_LIFF_ID is set (opens in-app), web URL otherwise.
 * The LIFF app's endpoint URL must be `${WEB_URL}/liff/tasks`. */
export function taskPageUrl(path: string): string {
  return config.LINE_LIFF_ID
    ? `https://liff.line.me/${config.LINE_LIFF_ID}${path}`
    : `${config.WEB_URL}/liff/tasks${path}`;
}

const dot = (color: string) => ({
  type: 'box',
  layout: 'vertical',
  contents: [],
  width: '10px',
  height: '10px',
  backgroundColor: color,
  cornerRadius: '2px',
});

function assigneeNames(assignees: Pick<TaskAssigneeRecord, 'display_name'>[]): string {
  const names = assignees.map((a) => a.display_name || 'สมาชิก');
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
}

function postbackButton(label: string, data: string, color: string): Record<string, unknown> {
  return {
    type: 'button',
    style: 'primary',
    height: 'sm',
    color,
    action: { type: 'postback', label, data, displayText: label },
  };
}

function uriButton(label: string, uri: string): Record<string, unknown> {
  return { type: 'button', style: 'secondary', height: 'sm', action: { type: 'uri', label, uri } };
}

/**
 * "สร้างงาน" entry card — ONE self-contained bubble (was a 3-bubble carousel,
 * which LINE renders as several swipeable cards → card overflow). REPLIED into
 * the chat (fresh replyToken from the triggering message) — not a push.
 *
 * Layout: an in-card type selector (งานเดียว / แยกรายการ / งานประจำ, งานเดียว
 * first) as tappable rows, then two distinct action buttons — "สร้างงาน"
 * (primary, defaults to the first type) and "ดูงานทั้งหมด" (secondary → the web
 * task list). LINE Flex is static — it can't hold a radio "selected" state and
 * submit later, so each type row deep-links straight into that type's create
 * flow; the row IS the select-and-create. `liffId` comes from
 * process.env.LINE_LIFF_ID (config.LINE_LIFF_ID); when it's unset the links
 * fall back to plain web URLs so the card still works in dev. NO emoji (brand
 * rule) — the type rows use native colored dots, not icons.
 */
export function buildCreateTaskCard(liffId: string | undefined, groupId: string): FlexMessage {
  const gq = `?groupId=${encodeURIComponent(groupId)}`;
  // groupId rides BOTH link forms. liff.getContext() loses the chat context in
  // real in-group cases (LINE Desktop, login round trips, forwarded/pinned
  // links), so the query param is the reliable capability — same trust model
  // as share links; the API still verifies group membership on every call.
  const createUrl = (type: string): string =>
    liffId
      ? `https://liff.line.me/${liffId}/create/${type}${gq}`
      : `${config.WEB_URL}/liff/tasks/create/${type}${gq}`;
  const listUrl = `${config.WEB_URL}/dashboard/tasks`;

  const TYPES: { type: string; title: string; desc: string }[] = [
    { type: 'single', title: 'งานเดียว', desc: 'มอบหมายงานหนึ่งชิ้น กำหนดส่งเดียว' },
    { type: 'multi', title: 'แยกรายการ', desc: 'หลายรายการ แยกคนและกำหนดส่งได้' },
    { type: 'recurring', title: 'งานประจำ', desc: 'ทำซ้ำเป็นรอบ หนูตั้งรอบใหม่ให้เอง' },
  ];

  // Tappable selector row: whole box deep-links to that type's create flow.
  // Brand-red dot + title in ink + one-line desc in muted gray; a light border
  // reads as a selectable option without any icon art.
  const typeRow = (t: (typeof TYPES)[number]): Record<string, unknown> => ({
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    alignItems: 'center',
    paddingAll: '12px',
    cornerRadius: '8px',
    borderWidth: '1px',
    borderColor: '#EAEAEA',
    action: { type: 'uri', label: t.title, uri: createUrl(t.type) },
    contents: [
      dot(BRAND_RED),
      {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        contents: [
          { type: 'text', text: t.title, weight: 'bold', size: 'sm', color: INK, wrap: true },
          { type: 'text', text: t.desc, size: 'xs', color: MUTED, wrap: true },
        ],
      },
    ],
  });

  return {
    type: 'flex',
    altText: 'สร้างงานใหม่',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: BRAND_RED,
        paddingAll: '16px',
        spacing: 'xs',
        contents: [
          { type: 'text', text: 'สร้างงานใหม่', weight: 'bold', size: 'lg', color: '#FFFFFF' },
          { type: 'text', text: 'เลือกรูปแบบงานที่จะมอบหมายในกลุ่ม', size: 'xs', color: '#FFFFFFCC' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#FFFFFF',
        paddingAll: '16px',
        spacing: 'sm',
        contents: TYPES.map(typeRow),
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#FFFFFF',
        spacing: 'sm',
        paddingAll: '12px',
        contents: [
          // Primary CTA — defaults to the first type (งานเดียว).
          {
            type: 'button',
            style: 'primary',
            height: 'sm',
            color: BRAND_RED,
            action: { type: 'uri', label: 'สร้างงาน', uri: createUrl(TYPES[0]!.type) },
          },
          // Secondary — jump to the full task list.
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: { type: 'uri', label: 'ดูงานทั้งหมด', uri: listUrl },
          },
        ],
      },
    },
  };
}

/** Flex pushed into the group right after a task is created from LIFF. */
export function buildTaskCreatedFlex(task: TaskWithDetails): FlexMessage {
  const deadlineText = task.global_deadline
    ? `กำหนดส่ง ${formatThaiDeadline(task.global_deadline)}`
    : 'กำหนดส่งรายข้อ';

  const itemRows = task.items.slice(0, 10).map((item, i) => ({
    type: 'box',
    layout: 'vertical',
    spacing: 'xs',
    margin: 'md',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          {
            type: 'text',
            text: task.type === 'multi' ? `${i + 1}. ${item.title}` : item.title,
            weight: 'bold',
            size: 'sm',
            color: INK,
            wrap: true,
            flex: 1,
          },
        ],
      },
      {
        type: 'text',
        text:
          assigneeNames(item.assignees) +
          (item.deadline ? ` • ${formatThaiDeadline(item.deadline)}` : ''),
        size: 'xs',
        color: MUTED,
        wrap: true,
      },
    ],
  }));

  return {
    type: 'flex',
    altText: `งานใหม่: ${task.title}`,
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: BRAND_RED,
        paddingAll: '16px',
        spacing: 'xs',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'text',
                text: TYPE_LABEL[task.type] ?? task.type,
                size: 'xs',
                color: '#FFFFFF',
                flex: 0,
              },
            ],
          },
          { type: 'text', text: task.title, weight: 'bold', size: 'lg', color: '#FFFFFF', wrap: true },
          { type: 'text', text: deadlineText, size: 'sm', color: '#FFFFFF' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#FFFFFF',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: 'มอบหมายให้', size: 'xs', color: BRAND_RED, weight: 'bold' },
          ...itemRows,
          ...(task.items.length > 10
            ? [{ type: 'text', text: `และอีก ${task.items.length - 10} รายการ`, size: 'xs', color: MUTED, margin: 'md' }]
            : []),
        ],
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        paddingAll: '12px',
        contents: [
          uriButton('ดูงาน', taskPageUrl(`/${task.id}`)),
          postbackButton('รับทราบ', `action=task_accept&taskId=${task.id}`, BRAND_RED),
        ],
      },
    },
  };
}

/**
 * Reminder card: urgency-colored header, ONLY the people/items still pending.
 * `item` = null for the global-deadline round (covers every inheriting item).
 */
export function buildReminderFlex(
  task: TaskWithDetails,
  item: TaskItemWithAssignees | null,
  remindType: RemindType,
): FlexMessage {
  const color = URGENCY_COLOR[remindType];
  // The null-item round covers exactly the items inheriting global_deadline
  // (items with their own deadline get their own round — see reminderTargets).
  const items = item ? [item] : task.items.filter((i) => !i.deadline);
  const deadline = item ? effectiveDeadline(task, item) : task.global_deadline;

  const pendingRows = items
    .filter((i) => i.status !== 'done' && i.status !== 'cancelled')
    .flatMap((i) => {
      const pending = i.assignees.filter((a) => a.done_at === null);
      if (pending.length === 0) return [];
      return [
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'sm',
          margin: 'md',
          alignItems: 'center',
          contents: [
            dot(color),
            {
              type: 'box',
              layout: 'vertical',
              flex: 1,
              contents: [
                { type: 'text', text: i.title, size: 'sm', weight: 'bold', color: INK, wrap: true },
                { type: 'text', text: assigneeNames(pending), size: 'xs', color: MUTED, wrap: true },
              ],
            },
          ],
        },
      ];
    });

  return {
    type: 'flex',
    altText: `เตือนงาน: ${task.title}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: color,
        paddingAll: '16px',
        spacing: 'xs',
        contents: [
          { type: 'text', text: URGENCY_LABEL[remindType], size: 'xs', color: '#FFFFFFCC', weight: 'bold' },
          { type: 'text', text: task.title, weight: 'bold', size: 'md', color: '#FFFFFF', wrap: true },
          ...(deadline
            ? [{ type: 'text', text: `กำหนด ${formatThaiDeadline(deadline)}`, size: 'xs', color: '#FFFFFFCC' }]
            : []),
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: 'ยังค้างอยู่', size: 'xs', color: MUTED, weight: 'bold' },
          ...pendingRows,
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '12px',
        contents: [
          postbackButton(
            'เสร็จแล้ว',
            `action=task_done&taskId=${task.id}${item ? `&itemId=${item.id}` : ''}`,
            color,
          ),
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              uriButton('ดูงาน', taskPageUrl(`/${task.id}`)),
              uriButton('บันทึกปฏิทิน', `${config.APP_URL}/tasks/${task.id}/ics`),
            ],
          },
        ],
      },
    },
  };
}

/**
 * textV2 mention message — sent BEFORE the reminder Flex (LINE renders real
 * @mentions only via textV2 substitution; placeholder keys are matched to the
 * substitution map, no manual index math needed or possible here).
 */
/** LINE rejects a text message carrying more than 20 mentions — overflow
 * assignees are simply not @-mentioned (they still appear in the Flex card). */
const MAX_MENTIONS = 20;

export function buildMentionTextV2(
  pendingAssignees: Pick<TaskAssigneeRecord, 'line_uid'>[],
  headerText: string,
): Record<string, unknown> {
  const unique = [...new Map(pendingAssignees.map((a) => [a.line_uid, a])).values()].slice(
    0,
    MAX_MENTIONS,
  );
  const substitution: Record<string, unknown> = {};
  const placeholders = unique.map((a, i) => {
    const key = `user${i + 1}`;
    substitution[key] = { type: 'mention', mentionee: { type: 'user', userId: a.line_uid } };
    return `{${key}}`;
  });
  return {
    type: 'textV2',
    text: `${placeholders.join(' ')} ${headerText}`,
    substitution,
  };
}
