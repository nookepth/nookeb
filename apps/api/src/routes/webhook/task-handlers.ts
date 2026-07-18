import type { FastifyInstance } from 'fastify';
import { getChatMemberProfile, replyMessage } from '../../services/line.service';
import {
  getTaskWithDetails,
  markAssigneeAccepted,
  markAssigneeDone,
  rollUpCompletion,
  upsertGroupMember,
} from '../../services/task.service';
import { cancelReminders } from '../../services/taskScheduler';

/**
 * ระบบตามงาน webhook handlers, kept out of line.ts to contain its growth.
 * Everything here is REPLY-based (postbacks and the /register text command all
 * carry a replyToken) — the task feature's push exception applies only to the
 * LIFF announcement and the scheduled reminders.
 */

/** Structural subset of line.ts's LineMessageEvent (not exported there). */
export interface TaskWebhookEvent {
  replyToken?: string;
  source: { type: 'user' | 'group' | 'room'; userId?: string; groupId?: string; roomId?: string };
  postback?: { data: string };
}

async function replyText(event: TaskWebhookEvent, text: string): Promise<void> {
  if (!event.replyToken) return;
  await replyMessage(event.replyToken, [{ type: 'text', text }]);
}

/**
 * Postback router for the task Flex buttons:
 *   action=task_accept&taskId=…            → stamp accepted_at on the tapper's items
 *   action=task_done&taskId=…[&itemId=…]   → stamp done_at (one item, or all of
 *                                            the tapper's items when omitted)
 * Returns true when the data belonged to this feature (caller stops routing).
 */
export async function handleTaskPostback(
  app: FastifyInstance,
  event: TaskWebhookEvent,
): Promise<boolean> {
  const data = event.postback?.data ?? '';
  if (!data.startsWith('action=task_')) return false;
  const lineUid = event.source.userId;
  if (!lineUid) return true;

  const params = new URLSearchParams(data);
  const action = params.get('action');
  const taskId = params.get('taskId');
  const itemId = params.get('itemId');
  if (!taskId) return true;

  try {
    const task = await getTaskWithDetails(app.supabase, taskId);
    if (!task || task.status === 'cancelled') {
      await replyText(event, 'งานนี้ไม่อยู่แล้วน้า');
      return true;
    }

    const myItems = task.items.filter(
      (i) =>
        (!itemId || i.id === itemId) && i.assignees.some((a) => a.line_uid === lineUid),
    );
    if (myItems.length === 0) {
      await replyText(event, 'งานนี้ไม่ได้มอบหมายให้เราน้า');
      return true;
    }

    if (action === 'task_accept') {
      for (const item of myItems) {
        await markAssigneeAccepted(app.supabase, item.id, lineUid);
      }
      await replyText(event, `รับทราบ "${task.title}" แล้วน้า สู้ๆ น้า`);
      return true;
    }

    if (action === 'task_done') {
      for (const item of myItems) {
        await markAssigneeDone(app.supabase, item.id, lineUid);
      }
      const { taskDone } = await rollUpCompletion(app.supabase, task.id);
      if (taskDone) {
        await cancelReminders(app.supabase, task);
        await replyText(event, `งาน "${task.title}" เสร็จครบทุกคนแล้ว เก่งมากเลยน้า`);
      } else {
        await replyText(event, `บันทึกส่วนของเราใน "${task.title}" ว่าเสร็จแล้วน้า`);
      }
      return true;
    }

    return true;
  } catch (err) {
    app.log.error({ err, taskId, action }, 'task postback handling failed');
    await replyText(event, 'ขอโทษนะคะ เกิดข้อผิดพลาด ลองใหม่อีกทีน้า').catch(() => {});
    return true;
  }
}

/**
 * "/register" / "สมัคร" in a group: opt the sender into the group's assignee
 * roster (group_members). Profile fetched from LINE — never client-supplied.
 */
export async function handleRegisterCommand(
  app: FastifyInstance,
  event: TaskWebhookEvent,
): Promise<void> {
  const lineUid = event.source.userId;
  if (!lineUid) return;
  const groupId = event.source.groupId ?? event.source.roomId;
  if (!groupId) {
    await replyText(event, 'คำสั่งนี้ใช้ในกลุ่มน้า ไว้ให้เพื่อนๆ ลงทะเบียนรับงานกัน');
    return;
  }
  try {
    // Group-scoped fetch — resolves members who never friended the OA.
    const profile = await getChatMemberProfile(groupId, lineUid);
    await upsertGroupMember(
      app.supabase,
      groupId,
      lineUid,
      profile?.displayName ?? null,
      profile?.pictureUrl ?? null,
    );
    const name = profile?.displayName ? ` (${profile.displayName})` : '';
    await replyText(event, `ลงทะเบียนแล้วน้า${name} เลือกมอบหมายงานให้กันได้เลย`);
  } catch (err) {
    app.log.error({ err, lineUid, groupId }, 'group member register failed');
    await replyText(event, 'ขอโทษนะคะ ลงทะเบียนไม่สำเร็จ ลองใหม่อีกทีน้า').catch(() => {});
  }
}
