import type { FastifyInstance } from 'fastify';
import { TASK_NOTIFICATIONS_ENABLED } from '@nookeb/shared';
import { getChatMemberProfile, replyMessage, type LineMessage } from '../../services/line.service';
import {
  buildTaskCommandHelpCard,
  buildTaskConfirmCard,
  buildTaskCreatedFlex,
} from '../../services/lineMessage';
import {
  createTaskWithItems,
  listGroupMembers,
  upsertGroupMember,
} from '../../services/task.service';
import { scheduleReminders } from '../../services/taskScheduler';
import {
  MAX_REMINDER_COUNT,
  parseTaskCommand,
  type LineMentionee,
  type TaskCommandErrorCode,
} from '../../services/task-command';
import { detectNaturalTask } from '../../services/task-nl';
import {
  claimPendingConfirm,
  completePartialWithDue,
  confirmKey,
  deletePendingConfirm,
  getPendingPartial,
  restorePendingConfirm,
  storePendingConfirm,
  storePendingPartial,
  deletePendingPartial,
  type PendingTaskConfirm,
  type StoredAssignee,
} from '../../services/task-confirm';
import { logEvent } from '../../services/events.service';
import { config } from '../../config';
import { enqueueSheetsSync } from '../../services/sheetsQueue';

/**
 * ระบบตามงาน — in-chat group task commands, kept out of line.ts to contain its
 * growth (same split as task-handlers.ts):
 *
 *   หนูเก็บเตือนงาน                              → the help / instruction card
 *   หนูเก็บเตือนงาน @… งาน ส่ง … [เตือน N ครั้ง]  → parse + CONFIRM card (not create)
 *   <@mention …> (natural language, no prefix)  → lightweight detection → CONFIRM
 *   task_cmd_confirm / task_cmd_cancel postback → create the task / drop it
 *
 * CONFIRM-FIRST: a command no longer creates the task immediately. It parses the
 * intent, stashes it in Redis (task-confirm.ts), and REPLIES a confirmation card;
 * the task is created only when the commander taps ยืนยัน. This guards against a
 * mis-tagged assignee or a mis-read date going straight into a real task + push.
 *
 * REPLY-ONLY: every message here (command, NL, follow-up, confirm/cancel) carries
 * a live replyToken, so everything is a REPLY — NOT the sanctioned task push, and
 * NEVER a DM. Scheduled reminders (when TASK_NOTIFICATIONS_ENABLED flips on) push
 * to the GROUP chat via notifyTarget, still never a DM to assignees.
 */

/** Structural subset of line.ts's LineMessageEvent (not exported there). */
export interface TaskCommandEvent {
  replyToken?: string;
  source: { type: 'user' | 'group' | 'room'; userId?: string; groupId?: string; roomId?: string };
  message?: { id: string; text?: string; mention?: { mentionees?: LineMentionee[] } };
  postback?: { data: string };
}

async function reply(event: TaskCommandEvent, messages: LineMessage[]): Promise<void> {
  if (!event.replyToken) return;
  await replyMessage(event.replyToken, messages);
}

async function replyText(event: TaskCommandEvent, text: string): Promise<void> {
  await reply(event, [{ type: 'text', text }]);
}

/**
 * Help card on a bare "หนูเก็บเตือนงาน" (and the legacy bare "หนูเก็บสั่งงาน").
 * The group id (when the card is replied into a group/room) gives the card its
 * เปิดดูงาน + สร้างงานใหม่ buttons — the pair inherited from the retired
 * "หนูเก็บสร้างงาน" card.
 */
export async function handleTaskCommandHelp(_app: FastifyInstance, event: TaskCommandEvent): Promise<void> {
  const groupId = event.source.groupId ?? event.source.roomId ?? null;
  await reply(event, [buildTaskCommandHelpCard(true, config.LINE_LIFF_ID, groupId)]);
}

/** Clear, non-technical Thai copy for each parse failure — never assigns silently. */
const ERROR_TEXT: Record<TaskCommandErrorCode, string> = {
  mention_all: 'แท็กทุกคนพร้อมกันไม่ได้น้า ลองแท็กเป็นรายคนที่จะมอบงานให้น้า',
  unresolved_mention:
    'มีคนที่หนูยังไม่รู้จักในกลุ่มนี้น้า เขาต้องเคยพิมพ์ในกลุ่มนี้ หรือเพิ่มหนูเก็บเป็นเพื่อนก่อน แล้วลองแท็กใหม่อีกทีน้า',
  no_assignee: 'อย่าลืมแท็กคนที่จะมอบงานให้ด้วยน้า พิมพ์ "หนูเก็บเตือนงาน" เฉยๆ เพื่อดูวิธีใช้ได้เลยน้า',
  missing_due:
    'อย่าลืมบอกกำหนดส่งด้วยน้า เช่น "ส่งพรุ่งนี้ 17:00" — พิมพ์ "หนูเก็บเตือนงาน" เฉยๆ ดูตัวอย่างได้น้า',
  invalid_due:
    'หนูอ่านวันเวลาไม่ออกน้า ลองใหม่แบบ "ส่ง 25/12 18:00" หรือ "ส่งพรุ่งนี้" น้า (ต้องเป็นเวลาในอนาคต)',
  no_title: 'ยังไม่เห็นรายละเอียดงานเลยน้า บอกหนูหน่อยว่าให้ทำอะไร แล้วพิมพ์ใหม่อีกทีน้า',
};

/** True when the message is just the bare command word with no arguments. */
function isBareCommand(rawText: string): boolean {
  return /^\s*(?:หนูเก็บ)?\s*(?:เตือนงาน|สั่งงาน)\s*$/u.test(
    rawText.replace(/[​-‍﻿]/g, '').normalize('NFC'),
  );
}

async function resolvePlanIsPro(app: FastifyInstance, lineUserId: string): Promise<boolean> {
  const { data } = await app.supabase
    .from('users')
    .select('plan')
    .eq('line_user_id', lineUserId)
    .maybeSingle();
  const plan = (data as { plan?: string } | null)?.plan;
  return plan === 'pro' || plan === 'team';
}

/**
 * Resolve each mentioned uid to a {name, avatar} snapshot and enroll them in the
 * group roster. A uid that reached here already carries a LINE userId (the
 * parser rejects mentions without one), and being @mentioned in this group is
 * proof of membership — so this only fills in the display name (best-effort; a
 * uid LINE can't name is still assigned, shown as "สมาชิก").
 */
async function resolveAssignees(
  app: FastifyInstance,
  groupId: string,
  uids: string[],
): Promise<StoredAssignee[]> {
  const roster = await listGroupMembers(app.supabase, groupId);
  const byUid = new Map(roster.map((m) => [m.line_uid, m]));
  const out: StoredAssignee[] = [];
  for (const uid of uids) {
    const existing = byUid.get(uid);
    if (existing?.display_name) {
      out.push({ lineUid: uid, displayName: existing.display_name, pictureUrl: existing.picture_url });
      continue;
    }
    const profile = await getChatMemberProfile(groupId, uid);
    const displayName = profile?.displayName ?? existing?.display_name ?? null;
    const pictureUrl = profile?.pictureUrl ?? existing?.picture_url ?? null;
    // Enroll/refresh so the assignee also shows up in the dashboard roster.
    await upsertGroupMember(app.supabase, groupId, uid, displayName, pictureUrl);
    out.push({ lineUid: uid, displayName, pictureUrl });
  }
  return out;
}

/** First assignee's display name (or a count) for the follow-up question copy. */
function assigneeSummary(assignees: StoredAssignee[]): string {
  const names = assignees.map((a) => a.displayName || 'สมาชิก');
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} และ ${names[1]}`;
  return `${names[0]} และอีก ${names.length - 1} คน`;
}

/**
 * Shared "stash the intent + reply the confirmation card" step for BOTH the
 * strict command and the natural-language high-confidence path. Resolves the
 * assignee snapshot, applies the Pro gate to the reminder count (the card must
 * show the EFFECTIVE count, or the Pro note when blocked), stores the pending
 * confirm (replacing any prior one for this group+commander), and replies.
 */
async function presentConfirmation(
  app: FastifyInstance,
  event: TaskCommandEvent,
  args: {
    groupId: string;
    commanderId: string;
    sourceMessageId: string;
    assigneeUids: string[];
    title: string;
    dueIso: string;
    reminderCount: number | null;
    /** Assignee snapshot if already resolved (NL medium reuses it); else resolve. */
    assignees?: StoredAssignee[];
  },
): Promise<void> {
  const assignees = args.assignees ?? (await resolveAssignees(app, args.groupId, args.assigneeUids));

  const isPro = await resolvePlanIsPro(app, args.commanderId);
  const requested = args.reminderCount;
  const reminderBlocked = requested != null && !isPro;
  const reminderCount =
    requested != null && isPro ? Math.min(requested, MAX_REMINDER_COUNT) : null;

  const intent: PendingTaskConfirm = {
    groupId: args.groupId,
    commanderId: args.commanderId,
    assignees,
    title: args.title,
    dueIso: args.dueIso,
    reminderCount,
    reminderBlocked,
    sourceMessageId: args.sourceMessageId,
  };
  await storePendingConfirm(app.redis, intent);

  await reply(event, [
    buildTaskConfirmCard({
      pendingKey: confirmKey(args.groupId, args.commanderId),
      assigneeNames: assignees.map((a) => a.displayName || 'สมาชิก'),
      title: args.title,
      dueIso: args.dueIso,
      reminderCount,
      reminderBlocked,
    }),
  ]);
}

/**
 * "หนูเก็บเตือนงาน …" — parse, validate, then show the CONFIRMATION card (does NOT
 * create yet). Group/room only. The create happens on the ยืนยัน postback.
 */
export async function handleTaskCommandCreate(
  app: FastifyInstance,
  event: TaskCommandEvent,
): Promise<void> {
  const source = event.source;
  const groupId = source.groupId ?? source.roomId;
  const lineUserId = source.userId;

  // Group/room only — a personal task has a dedicated flow (งานส่วนตัว).
  if ((source.type !== 'group' && source.type !== 'room') || !groupId) {
    await replyText(
      event,
      'คำสั่ง "เตือนงาน" ใช้ในกลุ่มน้า ถ้าอยากทำงานส่วนตัว พิมพ์ "หนูเก็บเตือนงาน" เฉยๆ ในแชทนี้ได้เลยน้า',
    );
    return;
  }
  if (!lineUserId || !event.message) return;

  const rawText = event.message.text ?? '';
  const mentionees = event.message.mention?.mentionees ?? [];

  // Bare "หนูเก็บเตือนงาน" with nothing else → show the help card, not an error.
  if (mentionees.length === 0 && isBareCommand(rawText)) {
    await handleTaskCommandHelp(app, event);
    return;
  }

  const parsed = parseTaskCommand({ text: rawText, mentionees });
  if (!parsed.ok) {
    await replyText(event, ERROR_TEXT[parsed.code]);
    return;
  }

  try {
    await presentConfirmation(app, event, {
      groupId,
      commanderId: lineUserId,
      sourceMessageId: event.message.id,
      assigneeUids: parsed.value.assigneeUids,
      title: parsed.value.title,
      dueIso: parsed.value.dueIso,
      reminderCount: parsed.value.reminderCount,
    });
  } catch (err) {
    app.log.error({ err, groupId }, 'task command confirm-card failed');
    await replyText(event, 'ขอโทษน้า มีอะไรผิดพลาดตอนเตรียมงาน ลองใหม่อีกทีนะน้า 🔧').catch(() => {});
  }
}

/**
 * Lightweight NATURAL-LANGUAGE task detection for an un-prefixed group message
 * that @mentions someone. Returns true when it handled the message (replied a
 * confirm card OR asked the one due-date follow-up), false to fall through (LOW
 * confidence → the caller stays silent). NEVER creates a task directly — HIGH
 * confidence still routes through the confirmation card.
 */
export async function handleNaturalTaskMessage(
  app: FastifyInstance,
  event: TaskCommandEvent,
  groupId: string,
  commanderId: string,
): Promise<boolean> {
  if (!event.message) return false;
  const rawText = event.message.text ?? '';
  const mentionees = event.message.mention?.mentionees ?? [];

  const detected = detectNaturalTask({ text: rawText, mentionees });
  if (!detected) return false; // LOW confidence → do nothing

  try {
    const assignees = await resolveAssignees(app, groupId, detected.assigneeUids);

    if (detected.confidence === 'high' && detected.dueIso) {
      await presentConfirmation(app, event, {
        groupId,
        commanderId,
        sourceMessageId: event.message.id,
        assigneeUids: detected.assigneeUids,
        title: detected.title,
        dueIso: detected.dueIso,
        reminderCount: detected.reminderCount,
        assignees,
      });
      return true;
    }

    // MEDIUM: assignee + title, no due → stash a partial and ask ONE follow-up.
    await storePendingPartial(app.redis, {
      groupId,
      commanderId,
      assignees,
      title: detected.title,
      reminderCount: detected.reminderCount,
      sourceMessageId: event.message.id,
    });
    await replyText(
      event,
      `จะให้ ${assigneeSummary(assignees)} ส่ง "${detected.title}" เมื่อไหร่คะ? เช่น พรุ่งนี้ 17:00 หรือ 25/12 18:00 น้า`,
    );
    return true;
  } catch (err) {
    app.log.error({ err, groupId }, 'natural task detection failed');
    return false; // fail silent — don't nag on an internal error
  }
}

/**
 * Follow-up handler: when a group message arrives from someone who has a pending
 * NL "awaiting due date" partial, try to read a due date out of it and, on
 * success, complete the intent into a confirmation card. Returns true only when
 * it consumed the partial (replied a card). A non-date reply is IGNORED (returns
 * false, leaves the partial to expire) — we never ask more than once.
 */
export async function handlePendingDueReply(
  app: FastifyInstance,
  event: TaskCommandEvent,
  groupId: string,
  commanderId: string,
): Promise<boolean> {
  const partial = await getPendingPartial(app.redis, groupId, commanderId);
  if (!partial) return false;
  const text = event.message?.text ?? '';

  const completed = completePartialWithDue(partial, text, Date.now());
  if (!completed) return false; // not a date → stay silent, let the partial expire

  await deletePendingPartial(app.redis, groupId, commanderId);
  try {
    await presentConfirmation(app, event, {
      groupId,
      commanderId,
      sourceMessageId: completed.sourceMessageId,
      assigneeUids: completed.assignees.map((a) => a.lineUid),
      title: completed.title,
      dueIso: completed.dueIso,
      reminderCount: completed.reminderCount,
      assignees: completed.assignees, // reuse the snapshot — no re-resolve
    });
  } catch (err) {
    app.log.error({ err, groupId }, 'pending due-reply confirm-card failed');
    await replyText(event, 'ขอโทษน้า มีอะไรผิดพลาดตอนเตรียมงาน ลองพิมพ์ใหม่อีกทีนะน้า 🔧').catch(() => {});
  }
  return true;
}

/**
 * Create the task from a claimed pending-confirm intent, schedule reminders, and
 * REPLY the created-task card into the group. Idempotent per the ORIGINAL command
 * message id, so two confirm taps (or two pending cards from a redelivered
 * command) can never double-create. On create failure the pending intent is
 * restored so the commander can tap ยืนยัน again.
 */
async function createTaskFromConfirm(
  app: FastifyInstance,
  event: TaskCommandEvent,
  intent: PendingTaskConfirm,
): Promise<void> {
  // Idempotency on the original command message id (guards a duplicated pending).
  const idemKey = `nookeb:taskcmd:${intent.sourceMessageId}`;
  const claimed = await app.redis.set(idemKey, '1', 'EX', 86400, 'NX');
  if (claimed === null) {
    await replyText(event, 'งานนี้หนูสร้างให้ไปแล้วน้า');
    return;
  }

  let task;
  try {
    const { data: space } = await app.supabase
      .from('spaces')
      .select('id')
      .eq('line_group_id', intent.groupId)
      .maybeSingle();
    const spaceId = (space as { id?: string } | null)?.id ?? null;

    task = await createTaskWithItems(app.supabase, {
      spaceId,
      groupLineId: intent.groupId,
      isPersonal: false,
      ownerLineUid: null,
      title: intent.title,
      type: 'single',
      globalDeadline: intent.dueIso,
      recurrenceRule: null,
      createdByLineUid: intent.commanderId,
      items: [{ title: intent.title, description: null, deadline: null, assignees: intent.assignees }],
      reminderCount: intent.reminderCount,
    });
  } catch (createErr) {
    // Release the idempotency claim AND restore the pending intent so the
    // commander can retry ยืนยัน — the failed create left no visible task.
    await app.redis.del(idemKey).catch(() => {});
    await restorePendingConfirm(app.redis, intent).catch(() => {});
    throw createErr;
  }

  // Reminders (gated by TASK_NOTIFICATIONS_ENABLED — currently a no-op; rows/jobs
  // materialise the moment it flips on, honoring reminderCount).
  await scheduleReminders(app.supabase, task);

  void logEvent(app.supabase, {
    eventType: 'task_create_submit',
    spaceId: task.space_id,
    source: 'line',
    metadata: {
      task_type: 'single',
      assignee_count: intent.assignees.length,
      has_deadline: true,
      via: 'line_command',
    },
  });
  // Mirror into the creator's Google Sheet if connected (no-op otherwise).
  enqueueSheetsSync(task.id, 'upsert');

  const messages: LineMessage[] = [];
  if (intent.reminderBlocked) {
    messages.push({
      type: 'text',
      text: 'ตั้งเตือนหลายครั้งเป็นฟีเจอร์ Pro น้า งานนี้หนูสร้างให้เรียบร้อยแล้ว แต่ยังไม่ได้ตั้งเตือนหลายครั้งให้น้า',
    });
  } else if (intent.reminderCount != null && TASK_NOTIFICATIONS_ENABLED) {
    messages.push({ type: 'text', text: `รับทราบน้า หนูจะเตือนให้ ${intent.reminderCount} ครั้งเลยน้า` });
  }
  messages.push(buildTaskCreatedFlex(task));
  await reply(event, messages);
}

/**
 * Postback router for the confirmation card buttons:
 *   task_cmd_confirm:{key}  → create the pending task
 *   task_cmd_cancel:{key}   → drop the pending task
 *
 * The key is validated by RECONSTRUCTING it from the live event (group + tapper):
 * only the commander who issued the command, in the same group, can act on their
 * own pending intent — a forged/stale key or another member's tap is rejected.
 * Returns true when the data belonged to this feature (caller stops routing).
 */
export async function handleTaskConfirmPostback(
  app: FastifyInstance,
  event: TaskCommandEvent,
): Promise<boolean> {
  const data = event.postback?.data ?? '';
  let action: 'confirm' | 'cancel';
  let key: string;
  if (data.startsWith('task_cmd_confirm:')) {
    action = 'confirm';
    key = data.slice('task_cmd_confirm:'.length);
  } else if (data.startsWith('task_cmd_cancel:')) {
    action = 'cancel';
    key = data.slice('task_cmd_cancel:'.length);
  } else {
    return false;
  }

  const groupId = event.source.groupId ?? event.source.roomId;
  const tapper = event.source.userId;
  if (!groupId || !tapper) return true; // can't scope it — swallow silently

  // Only the commander (the key's owner), in this group, may confirm/cancel.
  if (key !== confirmKey(groupId, tapper)) {
    await replyText(event, 'ให้คนที่สั่งงานเป็นคนกดยืนยันหรือยกเลิกน้า');
    return true;
  }

  try {
    if (action === 'cancel') {
      await deletePendingConfirm(app.redis, groupId, tapper);
      await replyText(event, 'ยกเลิกแล้วค่ะ ถ้าจะสั่งงานใหม่พิมพ์มาได้เลยน้า');
      return true;
    }

    // confirm: atomically claim so a double-tap / redelivery can't double-create.
    const intent = await claimPendingConfirm(app.redis, groupId, tapper);
    if (!intent) {
      await replyText(event, 'คำสั่งหมดอายุแล้ว กรุณาพิมพ์ใหม่');
      return true;
    }
    await createTaskFromConfirm(app, event, intent);
    return true;
  } catch (err) {
    app.log.error({ err, groupId, action }, 'task confirm postback failed');
    await replyText(event, 'ขอโทษน้า มีอะไรผิดพลาด ลองใหม่อีกทีนะน้า 🔧').catch(() => {});
    return true;
  }
}
