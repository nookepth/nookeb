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

const URGENCY_COLOR: Record<RemindType, string> = {
  '3_days': '#00B900',
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
 * "สร้างงาน" entry card — a 3-bubble carousel (single / multi / recurring), each
 * opening the LIFF create flow for that type. REPLIED into the chat (fresh
 * replyToken from the triggering message) — not a push. `liffId` comes from
 * process.env.LINE_LIFF_ID (config.LINE_LIFF_ID); when it's unset the buttons
 * fall back to the plain web create URL so the card still works in dev.
 * NO emoji (brand rule).
 */
export function buildCreateTaskCard(liffId: string | undefined, groupId: string): FlexMessage {
  const gq = `?groupId=${encodeURIComponent(groupId)}`;
  const createUrl = (type: string): string =>
    liffId
      ? `https://liff.line.me/${liffId}/create/${type}`
      : `${config.WEB_URL}/liff/tasks/create/${type}${gq}`;

  const CARDS: { type: string; title: string; desc: string; color: string }[] = [
    {
      type: 'single',
      title: 'งานเดียว',
      desc: 'มอบหมายงานหนึ่งชิ้น กำหนดส่งเดียว เหมาะกับงานเร่งด่วนสั้นๆ',
      color: '#0D9488',
    },
    {
      type: 'multi',
      title: 'แยกรายการ',
      desc: 'หลายรายการในงานเดียว แต่ละข้อมอบหมายคนและกำหนดส่งแยกกันได้',
      color: '#2563EB',
    },
    {
      type: 'recurring',
      title: 'งานประจำ',
      desc: 'งานที่ต้องทำซ้ำเป็นรอบ หนูตั้งรอบใหม่ให้เองทุกครั้งที่ถึงกำหนด',
      color: '#7C3AED',
    },
  ];

  const bubble = (card: (typeof CARDS)[number]): Record<string, unknown> => ({
    type: 'bubble',
    size: 'micro',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: card.color,
      paddingAll: '14px',
      contents: [{ type: 'text', text: card.title, weight: 'bold', size: 'md', color: '#FFFFFF', wrap: true }],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      contents: [{ type: 'text', text: card.desc, size: 'xs', color: '#555555', wrap: true }],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        {
          type: 'button',
          style: 'primary',
          height: 'sm',
          color: card.color,
          action: { type: 'uri', label: 'สร้างงานนี้', uri: createUrl(card.type) },
        },
      ],
    },
  });

  return {
    type: 'flex',
    altText: 'สร้างงานใหม่',
    contents: { type: 'carousel', contents: CARDS.map(bubble) },
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
        color: '#888888',
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
        backgroundColor: '#0D9488',
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
                color: '#CCFBF1',
                flex: 0,
              },
            ],
          },
          { type: 'text', text: task.title, weight: 'bold', size: 'lg', color: '#FFFFFF', wrap: true },
          { type: 'text', text: deadlineText, size: 'sm', color: '#CCFBF1' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: 'มอบหมายให้', size: 'xs', color: '#0D9488', weight: 'bold' },
          ...itemRows,
          ...(task.items.length > 10
            ? [{ type: 'text', text: `และอีก ${task.items.length - 10} รายการ`, size: 'xs', color: '#888888', margin: 'md' }]
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
          postbackButton('รับงาน', `action=task_accept&taskId=${task.id}`, '#0D9488'),
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
                { type: 'text', text: i.title, size: 'sm', weight: 'bold', wrap: true },
                { type: 'text', text: assigneeNames(pending), size: 'xs', color: '#888888', wrap: true },
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
          { type: 'text', text: 'ยังค้างอยู่', size: 'xs', color: '#888888', weight: 'bold' },
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
export function buildMentionTextV2(
  pendingAssignees: Pick<TaskAssigneeRecord, 'line_uid'>[],
  headerText: string,
): Record<string, unknown> {
  const unique = [...new Map(pendingAssignees.map((a) => [a.line_uid, a])).values()];
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
