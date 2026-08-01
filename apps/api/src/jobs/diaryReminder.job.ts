/**
 * Diary reminder push (§17) — FREE 5 per month, PRO/PREMIUM daily.
 *
 * DELIVERY IS A LINE PUSH, which makes this the one place in the membership
 * system that leaves the database. Two constraints shape it:
 *
 *  - Project rule 10 is reply-only messaging; pushes are sanctioned only for
 *    the Task Manager. A diary push is a NEW sanctioned exception introduced by
 *    the membership spec (§17 says "via LINE"), so it is written to be as
 *    cheap and as skippable as possible: one message, no Flex, and it is
 *    skipped entirely for users who already wrote today.
 *  - Push quota is metered and fails silently when exhausted. Every send is
 *    individually try/caught so one bad recipient cannot stop the sweep.
 *
 * The FREE allowance is enforced through the ordinary quota engine
 * (`diary_reminders`, 5/month), which means a free user's 5 pushes are spread
 * across whichever days they happen to still be missing an entry — not the
 * first 5 days of the month. That is the useful reading of "5 times/month".
 *
 * EXTERNAL DEPENDENCY: needs LINE_CHANNEL_ACCESS_TOKEN. Without it
 * `pushMessage` throws per recipient and the sweep logs and continues.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { DIARY_ADDON_ENABLED, normalizePlan } from '../config/plans';
import { consumeQuota } from '../services/quota.service';
import {
  alreadyWrittenToday,
  bangkokHour,
  isActiveSubscriber,
  listDueSubscribers,
  logSent,
  logSkipped,
} from '../services/diaryAddon.service';
import type { FlexMessage } from '../services/flex.service';

/**
 * Notifications disabled — reminder interval picker UI not shipped yet (gap #9)
 *
 * Master switch for the diary nudge, mirroring TASK_NOTIFICATIONS_ENABLED in
 * packages/shared/src/task-notifications.ts. While false:
 *
 *   - `scheduleMembershipJobs` registers no repeatable sweep, so nothing is
 *     queued in the first place;
 *   - `runDiaryReminderSweep` returns an empty result immediately, standing
 *     down any job that was queued before the flag flipped (belt-and-braces,
 *     the same shape as `processTaskReminder`).
 *
 * NOTHING ELSE IS TOUCHED: `diary_notification_settings` rows, the
 * `diary_reminders` quota feature and every already-consumed unit are left
 * exactly as they are. Flip this back to `true` and the sweep re-enables with
 * no other code change.
 */
export const DIARY_REMINDER_ENABLED = false;

/** Bangkok calendar date (YYYY-MM-DD) for an instant — same trick as billing-period. */
function bangkokDate(at: Date): string {
  const shifted = new Date(at.getTime() + 7 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface DiaryReminderResult {
  candidates: number;
  sent: number;
  skippedWroteToday: number;
  skippedQuota: number;
  failed: number;
}

export interface DiaryReminderDeps {
  /** Injected so the sweep is testable without the LINE SDK. */
  push: (to: string, text: string) => Promise<void>;
  now?: Date;
  /** Safety cap per run — a runaway sweep must not drain the push quota. */
  maxRecipients?: number;
}

const REMINDER_TEXT =
  'วันนี้ยังไม่ได้เขียนไดอารี่เลยน้า ส่งรูปกับข้อความมาให้หนูเก็บไว้ได้เลยน้า 📔';

export async function runDiaryReminderSweep(
  supabase: SupabaseClient,
  deps: DiaryReminderDeps,
): Promise<DiaryReminderResult> {
  const now = deps.now ?? new Date();
  const today = bangkokDate(now);
  const cap = deps.maxRecipients ?? 5000;

  const result: DiaryReminderResult = {
    candidates: 0,
    sent: 0,
    skippedWroteToday: 0,
    skippedQuota: 0,
    failed: 0,
  };

  // Stand down before touching the database or consuming a single quota unit.
  // This runs even for jobs enqueued while the flag was still true.
  if (!DIARY_REMINDER_ENABLED) {
    console.log('[membership] diary reminders are disabled — sweep stood down');
    return result;
  }

  // Everyone who opted in. The per-user notify_time is NOT honoured here: this
  // sweep runs once at 20:00 ICT, which is the column's default. Respecting an
  // arbitrary per-user time needs an hourly sweep — noted in the gap report
  // rather than silently pretending the preference is applied.
  const { data: settings, error } = await supabase
    .from('diary_notification_settings')
    .select('user_id')
    .eq('is_enabled', true)
    .limit(cap);
  if (error) throw error;

  const userIds = (settings ?? []).map((s) => s.user_id as string);
  result.candidates = userIds.length;
  if (userIds.length === 0) return result;

  // Who already has a live entry for today — one query, not one per user.
  const { data: written, error: wErr } = await supabase
    .from('diary_entries')
    .select('user_id')
    .in('user_id', userIds)
    .eq('entry_date', today)
    .is('deleted_at', null);
  if (wErr) throw wErr;
  const wroteToday = new Set((written ?? []).map((r) => r.user_id as string));

  // Plans + LINE ids for the remainder.
  const pending = userIds.filter((id) => !wroteToday.has(id));
  result.skippedWroteToday = userIds.length - pending.length;
  if (pending.length === 0) return result;

  const { data: users, error: uErr } = await supabase
    .from('users')
    .select('id, line_user_id, plan')
    .in('id', pending);
  if (uErr) throw uErr;

  for (const row of (users ?? []) as { id: string; line_user_id: string; plan: string | null }[]) {
    if (!row.line_user_id) continue;
    const plan = normalizePlan(row.plan);

    // Reserve BEFORE sending. On pro/premium the limit is unlimited so this
    // always allows and simply records the count for analytics; on free it is
    // the 5-a-month gate.
    let allowed: boolean;
    try {
      const decision = await consumeQuota(supabase, {
        userId: row.id,
        feature: 'diary_reminders',
        plan,
      });
      allowed = decision.allowed;
    } catch (err) {
      console.error(`[membership] diary reminder quota check failed for ${row.id}:`, err);
      result.failed += 1;
      continue;
    }

    if (!allowed) {
      result.skippedQuota += 1;
      continue;
    }

    try {
      await deps.push(row.line_user_id, REMINDER_TEXT);
      result.sent += 1;
    } catch (err) {
      // The unit was already reserved. It is NOT released: a failed push is
      // usually an exhausted LINE quota or a blocked bot, and refunding would
      // make the sweep retry the same dead recipient every day for the rest of
      // the month. Losing one of five is the cheaper error.
      result.failed += 1;
      console.error(`[membership] diary reminder push failed for ${row.id}:`, err);
    }
  }

  console.log(
    `[membership] diary reminders: sent=${result.sent} wroteToday=${result.skippedWroteToday} ` +
      `quotaBlocked=${result.skippedQuota} failed=${result.failed}`,
  );
  return result;
}

// ===========================================================================
// หนูเก็บความทรงจำ — the paid ADD-ON sweep (migration 052)
//
// COMPLETELY SEPARATE from runDiaryReminderSweep above, which is the plan-based
// §17 allowance and stays switched off at DIARY_REMINDER_ENABLED. The two never
// share a flag, a queue entry, a quota or a log table:
//
//   §17 allowance : plan-gated, monthly quota, ONE daily 20:00 sweep, off.
//   the add-on    : paid per user on any plan, no quota, HOURLY sweep so each
//                   subscriber is nudged at the time THEY picked.
//
// A user could in principle hold both. They would then get two nudges on a day
// they wrote nothing — acceptable and currently impossible, since §17 is off.
// If §17 is ever switched on, decide there whether add-on holders are excluded.
//
// Why hourly rather than a per-user scheduled job: a delayed BullMQ job per
// subscriber per day is thousands of standing jobs whose ids must be revoked on
// every time change and cancellation. One cheap hourly query over an indexed
// column has none of that state, and the (user, date) unique log row makes a
// double run harmless.
// ===========================================================================

export interface DiaryAddonSweepResult {
  /** Live subscriptions whose notify_time fell in this Bangkok hour. */
  candidates: number;
  sent: number;
  skippedWroteToday: number;
  skippedExpired: number;
  /** Already logged for this Bangkok day — a retry or a duplicate run. */
  skippedAlreadyLogged: number;
  failed: number;
}

export interface DiaryAddonSweepDeps {
  /** Injected so the sweep is testable without the LINE SDK. */
  push: (to: string, messages: FlexMessage[]) => Promise<void>;
  now?: Date;
  /**
   * Public web origin for the "เขียนเลย" button. Passed in rather than read
   * from config so this module stays importable without an .env — the worker,
   * which already loads config, supplies it. Omitted → the card ships with no
   * button rather than a broken link.
   */
  webUrl?: string;
  /** Safety cap per run — a runaway sweep must not drain the push quota. */
  maxRecipients?: number;
  /**
   * Master-switch override. Defaults to DIARY_ADDON_ENABLED, which is a
   * module-level env read and therefore fixed for the lifetime of the process —
   * this exists so the unit tests can exercise BOTH sides of the flag without
   * re-importing the module. Production callers must never pass it.
   */
  enabled?: boolean;
}

const ADDON_TITLE = 'หนูเก็บ ทักมาเตือนน้า';
const ADDON_BODY =
  'วันนี้ยังไม่ได้เขียนไดอารี่เลยน้า อย่าลืมบันทึกความทรงจำของวันนี้ไว้นะ';
const ADDON_CTA = 'เขียนเลย';

const DIARY_PINK = '#E8608F';
const DIARY_PINK_SOFT = '#FDEFF5';

/**
 * The nudge card. No emoji (brand rule 13) — the accent is a coloured header,
 * the same shape as buildDiaryPromptCard in flex.service.
 *
 * The CTA deep-links to the DASHBOARD diary page rather than to the chat flow:
 * the user is already in the chat when they read this, and the web page is
 * where they can see the 365-grid they are about to leave a hole in.
 */
export function buildDiaryAddonReminderCard(webUrl?: string): FlexMessage {
  const footer = webUrl
    ? {
        footer: {
          type: 'box',
          layout: 'vertical',
          paddingAll: '12px',
          contents: [
            {
              type: 'button',
              style: 'primary',
              color: DIARY_PINK,
              height: 'sm',
              action: { type: 'uri', label: ADDON_CTA, uri: `${webUrl}/dashboard/diary` },
            },
          ],
        },
      }
    : {};

  return {
    type: 'flex',
    altText: `${ADDON_TITLE} — ${ADDON_BODY}`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: DIARY_PINK,
        paddingAll: '16px',
        contents: [
          { type: 'text', text: ADDON_TITLE, weight: 'bold', size: 'lg', color: '#FFFFFF', wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: ADDON_BODY, size: 'sm', color: '#333333', wrap: true },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: DIARY_PINK_SOFT,
            cornerRadius: '8px',
            paddingAll: '10px',
            contents: [
              {
                type: 'text',
                text: 'ส่งรูปกับข้อความมาให้หนูเก็บได้เลยน้า',
                size: 'xs',
                color: DIARY_PINK,
                weight: 'bold',
                align: 'center',
                wrap: true,
              },
            ],
          },
        ],
      },
      ...footer,
      styles: { header: { backgroundColor: DIARY_PINK }, body: { backgroundColor: '#FFFFFF' } },
    },
  };
}

/**
 * One hourly pass of the add-on nudge.
 *
 * Per-user work is individually try/caught: a blocked bot, an exhausted push
 * quota or one bad row must never stop the rest of the hour's subscribers from
 * being nudged. A failure is counted and the loop continues — and NO log row is
 * written for it, so the next hourly run (or a job retry) may try that user
 * again within the same day.
 */
export async function runDiaryAddonSweep(
  supabase: SupabaseClient,
  deps: DiaryAddonSweepDeps,
): Promise<DiaryAddonSweepResult> {
  const now = deps.now ?? new Date();
  const today = bangkokDate(now);
  const hour = bangkokHour(now);

  const result: DiaryAddonSweepResult = {
    candidates: 0,
    sent: 0,
    skippedWroteToday: 0,
    skippedExpired: 0,
    skippedAlreadyLogged: 0,
    failed: 0,
  };

  // Stand down before touching the database. This runs even for jobs enqueued
  // while the flag was still true (same belt-and-braces as the §17 sweep).
  if (!(deps.enabled ?? DIARY_ADDON_ENABLED)) {
    console.log('[diary-addon] disabled — hourly sweep stood down');
    return result;
  }

  const due = await listDueSubscribers(supabase, hour, now, deps.maxRecipients ?? 5000);
  result.candidates = due.length;
  if (due.length === 0) return result;

  // LINE ids for the whole batch in one query — the push needs line_user_id and
  // diary_addon_subscriptions only carries the internal users.id.
  const { data: users, error: uErr } = await supabase
    .from('users')
    .select('id, line_user_id')
    .in(
      'id',
      due.map((s) => s.user_id),
    );
  if (uErr) throw uErr;
  const lineIdOf = new Map(
    ((users as { id: string; line_user_id: string | null }[] | null) ?? []).map((u) => [
      u.id,
      u.line_user_id,
    ]),
  );

  const card = buildDiaryAddonReminderCard(deps.webUrl);

  for (const sub of due) {
    try {
      // 1. Already wrote today → nothing to nudge about. Logged as a skip so
      //    "หนูเก็บไม่ทักเลย" is answerable from data.
      if (await alreadyWrittenToday(supabase, sub.user_id, today)) {
        const { deduped } = await logSkipped(supabase, sub.user_id, today, 'already_wrote', now);
        if (deduped) result.skippedAlreadyLogged += 1;
        else result.skippedWroteToday += 1;
        continue;
      }

      // 2. Re-check the subscription per user. listDueSubscribers already
      //    filtered on status/expiry, but a subscription can lapse or be
      //    cancelled between that query and this push, and this is the last
      //    point before money-backed access is used.
      if (!(await isActiveSubscriber(supabase, sub.user_id, now))) {
        const { deduped } = await logSkipped(supabase, sub.user_id, today, 'expired', now);
        if (deduped) result.skippedAlreadyLogged += 1;
        else result.skippedExpired += 1;
        continue;
      }

      const lineUserId = lineIdOf.get(sub.user_id);
      if (!lineUserId) {
        // No LINE id = nothing to push to. Not a failure worth retrying every
        // hour, but not a skip reason the user chose either — just counted.
        result.failed += 1;
        continue;
      }

      // 3. Claim the day BEFORE pushing. The (user_id, date) unique row is the
      //    idempotency key: if a retry or an overlapping run gets here second,
      //    it sees `deduped` and does not push a second time. The cost is that
      //    a push failing after the claim loses that day's nudge — the cheaper
      //    error than double-messaging a paying user.
      const { deduped } = await logSent(supabase, sub.user_id, today, now);
      if (deduped) {
        result.skippedAlreadyLogged += 1;
        continue;
      }

      await deps.push(lineUserId, [card]);
      result.sent += 1;
    } catch (err) {
      result.failed += 1;
      console.error(`[diary-addon] reminder failed for ${sub.user_id}:`, err);
    }
  }

  console.log(
    `[diary-addon] hour=${hour} candidates=${result.candidates} sent=${result.sent} ` +
      `wroteToday=${result.skippedWroteToday} expired=${result.skippedExpired} ` +
      `alreadyLogged=${result.skippedAlreadyLogged} failed=${result.failed}`,
  );
  return result;
}
