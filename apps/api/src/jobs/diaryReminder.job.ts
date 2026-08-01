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
import { normalizePlan } from '../config/plans';
import { consumeQuota } from '../services/quota.service';

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
