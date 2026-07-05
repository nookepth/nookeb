/**
 * LINE push notifications for the referral flow — used by both the
 * POST /referral/redeem route and the webhook "/redeem" command. Builders live
 * in flex.service.ts (project convention); these wrappers resolve the target
 * LINE user id and push. Each throws on failure — callers wrap best-effort
 * (the redemption is already committed when these run, so a push failure must
 * never surface as a redeem error).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Redis } from 'ioredis';
import { config } from '../config';
import {
  buildRedeemSuccessFlexMessage,
  buildReferralProgressFlexMessage,
} from './flex.service';
import { pushMessage } from './line.service';
import { getReferralStatus } from './referral.service';

const GB = 1024 * 1024 * 1024;

/** users.line_user_id lookup (push targets are LINE ids, not app ids). */
async function getLineUserId(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('users')
    .select('line_user_id')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data?.line_user_id as string | undefined) ?? null;
}

/** "🎉 กรอกโค้ดสำเร็จ!" card → the user who just redeemed a code. */
export async function sendRedeemSuccessToReferee(
  supabase: SupabaseClient,
  refereeId: string,
  newStorageBytes: number,
): Promise<void> {
  const lineUserId = await getLineUserId(supabase, refereeId);
  if (!lineUserId) return;
  await pushMessage(lineUserId, [
    buildRedeemSuccessFlexMessage({
      totalGB: Number((newStorageBytes / GB).toFixed(2)),
      bonusGB: Number((config.REFERRAL_BONUS_BYTES / GB).toFixed(2)),
      dashboardUrl: `${config.WEB_URL}/dashboard`,
    }),
  ]);
}

/** Milestone/progress card → the owner of the code that was just redeemed. */
export async function sendReferralProgressToReferrer(
  supabase: SupabaseClient,
  redis: Redis,
  referrerId: string,
): Promise<void> {
  const lineUserId = await getLineUserId(supabase, referrerId);
  if (!lineUserId) return;
  // Status AFTER the redeem — referral_count is already incremented here.
  const status = await getReferralStatus(supabase, redis, referrerId);
  await pushMessage(lineUserId, [buildReferralProgressFlexMessage(status)]);
}
