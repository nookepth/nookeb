/**
 * บูธ (Group Boost) — the in-chat half of §3a.
 *
 * "type หนูเก็บบูธ in any group → bot replies with inline group selector."
 * The address prefix is REQUIRED (see the dispatcher in line.ts): บูธ is an
 * ordinary Thai word, and the bare form made the bot interrupt normal chatter.
 *
 * LINE has no multi-select control, so the "checkbox picker with a max" is
 * rendered as quick replies: one button per group the user can act on, and the
 * plan's remaining slots printed above them. Tapping a button posts back
 * `action=boost_on|boost_off&groupId=…`, which is handled here too.
 *
 * Reply-only (project rule 10) — every path answers on the event's own
 * replyToken and never pushes.
 */

import type { FastifyInstance } from 'fastify';
import { replyMessage, type LineMessage } from '../../services/line.service';
import { CAPACITY_LIMITS, hasFeature, normalizePlan, type Plan } from '../../config/plans';
import {
  boostGroup,
  getBoostStatus,
  listLiveBoosts,
  releaseBoost,
} from '../../services/boost.service';
import { ensureGroupMember } from '../../services/task.service';

interface BoostEventSource {
  type: 'user' | 'group' | 'room';
  userId?: string;
  groupId?: string;
  roomId?: string;
}

interface BoostEvent {
  replyToken?: string;
  postback?: { data: string };
}

/** Quick-reply items LINE will render under the message. Max 13 by API rule. */
const MAX_QUICK_REPLIES = 13;

function textWithQuickReplies(
  text: string,
  items: { label: string; data: string }[],
): LineMessage {
  const msg: Record<string, unknown> = { type: 'text', text };
  if (items.length > 0) {
    msg.quickReply = {
      items: items.slice(0, MAX_QUICK_REPLIES).map((i) => ({
        type: 'action',
        action: {
          type: 'postback',
          // LINE caps a quick-reply label at 20 chars; a longer group name would
          // make the whole message a 400, not a truncated button.
          label: i.label.slice(0, 20),
          data: i.data,
          displayText: i.label.slice(0, 20),
        },
      })),
    };
  }
  return msg as unknown as LineMessage;
}

/** Resolve the LINE uid to a nookeb user row (id + plan). */
async function resolveUser(
  app: FastifyInstance,
  lineUid: string,
): Promise<{ id: string; plan: Plan } | null> {
  const { data } = await app.supabase
    .from('users')
    .select('id, plan')
    .eq('line_user_id', lineUid)
    .maybeSingle();
  const row = data as { id: string; plan: string | null } | null;
  return row ? { id: row.id, plan: normalizePlan(row.plan) } : null;
}

/**
 * A short, human label for a group id. There is no groups table keyed by name
 * in this codebase — the roster is the only place a group's identity is
 * visible — so the label is the member count plus a short id suffix. Ugly but
 * honest; inventing a name we do not have would be worse.
 */
function groupLabel(groupId: string, boosted: boolean): string {
  return `${boosted ? '✅ ' : ''}กลุ่ม …${groupId.slice(-6)}`;
}

/**
 * Handle the `หนูเก็บบูธ` text command.
 *
 * In a GROUP: offers to boost/un-boost THIS group (the one the user is in) and
 * lists the slots already spent. In a 1-on-1: lists the boosts they currently
 * hold, because there is no "this group" to act on.
 */
export async function handleBoostCommand(
  app: FastifyInstance,
  event: BoostEvent,
  source: BoostEventSource,
  lineUid: string,
): Promise<void> {
  if (!event.replyToken) return;
  const reply = (msg: LineMessage): Promise<void> => replyMessage(event.replyToken!, [msg]);

  const user = await resolveUser(app, lineUid);
  if (!user) {
    await reply(
      textWithQuickReplies(
        'ยังไม่เจอบัญชีของพี่เลยน้า ลองเข้าเว็บหนูเก็บสักครั้งก่อนแล้วค่อยลองใหม่น้า',
        [],
      ),
    );
    return;
  }

  const max = CAPACITY_LIMITS.group_boosts[user.plan];
  if (!hasFeature(user.plan, 'group_boost')) {
    await reply(
      textWithQuickReplies(
        'บูธกลุ่มใช้ได้กับแพ็กเกจ Pro ขึ้นไปน้า\n' +
          `Pro บูธได้ ${CAPACITY_LIMITS.group_boosts.pro} กลุ่ม · ` +
          `Premium บูธได้ ${CAPACITY_LIMITS.group_boosts.premium} กลุ่มน้า ✨`,
        [],
      ),
    );
    return;
  }

  const status = await getBoostStatus(app.supabase, user.id, user.plan);
  const groupId = source.groupId ?? source.roomId ?? null;

  // 1-on-1: nothing to toggle, so just report what they hold.
  if (!groupId) {
    const lines = status.boosts.length
      ? status.boosts.map((b) => `• ${groupLabel(b.groupId, true)} (ถึง ${b.expiresAt.slice(0, 10)})`)
      : ['• ยังไม่ได้บูธกลุ่มไหนเลยน้า'];
    await reply(
      textWithQuickReplies(
        `บูธของพี่: ใช้ไป ${status.used}/${max} กลุ่มน้า\n${lines.join('\n')}\n\n` +
          'พิมพ์ "หนูเก็บบูธ" ในกลุ่มที่อยากบูธได้เลยน้า 🚀',
        status.boosts.map((b) => ({
          label: `ปลดบูธ …${b.groupId.slice(-6)}`,
          data: `action=boost_off&groupId=${b.groupId}`,
        })),
      ),
    );
    return;
  }

  // In a group — membership is the guard, same as every other group-keyed route.
  if (!(await ensureGroupMember(app.supabase, groupId, lineUid))) {
    await reply(
      textWithQuickReplies('ยังไม่เห็นเราในกลุ่มนี้เลยน้า ลองส่งข้อความในกลุ่มแล้วลองใหม่อีกที', []),
    );
    return;
  }

  const thisBoosted = status.boosts.some((b) => b.groupId === groupId);
  const items: { label: string; data: string }[] = [];

  if (thisBoosted) {
    items.push({ label: 'ปลดบูธกลุ่มนี้', data: `action=boost_off&groupId=${groupId}` });
  } else if (status.available > 0) {
    items.push({ label: 'บูธกลุ่มนี้', data: `action=boost_on&groupId=${groupId}` });
  } else {
    // Slots full — the spec's rule is "un-boost the current group first (or
    // replace if under limit)", so offer each occupied slot as the thing to
    // free. The user then types หนูเก็บบูธ again.
    for (const b of status.boosts) {
      items.push({
        label: `ปลด …${b.groupId.slice(-6)}`,
        data: `action=boost_off&groupId=${b.groupId}`,
      });
    }
  }

  const header = thisBoosted
    ? `กลุ่มนี้บูธอยู่แล้วน้า ✅ (ใช้ไป ${status.used}/${max})`
    : status.available > 0
      ? `บูธกลุ่มนี้ไหมน้า? เหลืออีก ${status.available}/${max} กลุ่มน้า 🚀`
      : `บูธครบ ${max} กลุ่มแล้วน้า ปลดกลุ่มเดิมก่อนแล้วค่อยบูธกลุ่มนี้ได้เลยน้า`;

  await reply(
    textWithQuickReplies(`${header}\nบูธ 1 ครั้งอยู่ได้ ${status.durationDays} วันน้า`, items),
  );
}

/**
 * Handle `action=boost_on` / `action=boost_off` postbacks.
 * Returns true when the postback belonged to this feature.
 */
export async function handleBoostPostback(
  app: FastifyInstance,
  event: BoostEvent,
  lineUid: string,
): Promise<boolean> {
  const data = event.postback?.data ?? '';
  if (!data.startsWith('action=boost_on') && !data.startsWith('action=boost_off')) return false;
  if (!event.replyToken) return true;

  const params = new URLSearchParams(data);
  const action = params.get('action');
  const groupId = params.get('groupId');
  const replyText = (text: string): Promise<void> =>
    replyMessage(event.replyToken!, [{ type: 'text', text }]);

  if (!groupId) return true;

  const user = await resolveUser(app, lineUid);
  if (!user) {
    await replyText('ยังไม่เจอบัญชีของพี่เลยน้า ลองเข้าเว็บหนูเก็บสักครั้งก่อนน้า');
    return true;
  }

  if (action === 'boost_off') {
    // No plan check: a downgraded user must always be able to release a boost.
    const released = await releaseBoost(app.supabase, user.id, groupId);
    await replyText(
      released ? 'ปลดบูธให้แล้วน้า ✅' : 'กลุ่มนี้ไม่ได้บูธอยู่น้า',
    );
    return true;
  }

  // boost_on — re-verify membership AND entitlement at tap time; the selector
  // may have been sitting in the chat since before a downgrade or a removal.
  if (!(await ensureGroupMember(app.supabase, groupId, lineUid))) {
    await replyText('ยังไม่เห็นเราในกลุ่มนี้เลยน้า ลองส่งข้อความในกลุ่มแล้วลองใหม่อีกที');
    return true;
  }

  const result = await boostGroup(app.supabase, {
    userId: user.id,
    groupId,
    plan: user.plan,
  });

  if (!result.ok) {
    await replyText(
      result.code === 'BOOST_NOT_AVAILABLE'
        ? 'บูธกลุ่มใช้ได้กับแพ็กเกจ Pro ขึ้นไปน้า'
        : `บูธครบ ${result.limit} กลุ่มแล้วน้า ปลดกลุ่มเดิมก่อนได้เลยน้า`,
    );
    return true;
  }

  const live = await listLiveBoosts(app.supabase, user.id);
  await replyText(
    result.alreadyBoosted
      ? 'กลุ่มนี้บูธอยู่แล้วน้า ✅'
      : `บูธกลุ่มนี้ให้แล้วน้า 🚀 อยู่ได้ถึง ${result.boost.expires_at.slice(0, 10)} ` +
          `(ใช้ไป ${live.length}/${CAPACITY_LIMITS.group_boosts[user.plan]})`,
  );
  return true;
}
