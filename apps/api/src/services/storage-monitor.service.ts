import type { SupabaseClient } from '@supabase/supabase-js';
import type { SpaceRecord, UserRecord } from '@nookeb/shared';
import { config } from '../config';
import { addPendingNotify } from './pending-notify.service';
import { logEvent } from './events.service';

/**
 * Storage warning notifications to the space owner at 80% / 95% usage.
 *
 * Delivery is reply-only (no pushes — CLAUDE.md "LINE Messaging — Critical
 * Rules"): the alert has no triggering interaction from the OWNER (it fires on
 * an uploader's storage adjustment), so it's queued in pending-notify and rides
 * along on the owner's next 1-on-1 interaction with the bot.
 *
 * Quota in this system is per-USER (users.storage_used / storage_limit — it is
 * the uploader's quota that gates uploads, see the batch handler). So the check
 * measures the quota of the user whose storage was just adjusted, and dedupes /
 * notifies per space via `space_storage_alerts` (migration 004). For personal
 * spaces — the common case — uploader and owner are the same person.
 */

/** Usage must drop below this % before a new round of alerts can fire again. */
const RESET_BELOW_PCT = 70;

interface StorageAlertRow {
  space_id: string;
  last_notified_threshold: number | null;
  notified_at: string | null;
}

const GB = 1024 * 1024 * 1024;
const fmtGb = (bytes: number): string => (bytes / GB).toFixed(1);

function buildAlertText(
  threshold: number,
  spaceName: string,
  used: number,
  limit: number,
): string {
  const pct = Math.floor((used / limit) * 100);
  const remaining = Math.max(0, limit - used);
  const usage =
    `ใช้ไปแล้ว ${fmtGb(used)} GB จาก ${fmtGb(limit)} GB (${pct}%)\n` +
    `เหลืออีก ${fmtGb(remaining)} GB เท่านั้น`;

  if (threshold >= config.STORAGE_WARN_THRESHOLD_HIGH) {
    return (
      `🚨 พื้นที่เก็บไฟล์ของ "${spaceName}" เกือบเต็มแล้ว!\n\n${usage}\n\n` +
      `⛔ สมาชิกในกลุ่มจะอัพโหลดไฟล์ไม่ได้ เมื่อพื้นที่เต็ม\n` +
      `กรุณาลบไฟล์หรือขยายพื้นที่โดยด่วน`
    );
  }
  return (
    `⚠️ พื้นที่เก็บไฟล์ของ "${spaceName}" ใกล้เต็มแล้ว\n\n${usage}\n\n` +
    `💡 แนะนำ: ลบไฟล์ที่ไม่ใช้ออก หรือติดต่อผู้ดูแลระบบเพื่อขยายพื้นที่`
  );
}

/** The space owner's LINE user id (notify target), or null if it can't be resolved. */
async function findOwnerLineUserId(
  supabase: SupabaseClient,
  spaceId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('space_members')
    .select('users!inner(line_user_id)')
    .eq('space_id', spaceId)
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const row = data as unknown as { users: { line_user_id: string } } | null;
  return row?.users.line_user_id ?? null;
}

/**
 * Check the user's quota after a storage adjustment and notify the space owner
 * when a threshold (80% / 95%) is newly crossed. One notification per threshold
 * per space; tracking resets once usage drops below 70%.
 *
 * Never throws — a monitoring failure must not fail the upload/delete that
 * triggered it. Every failure is logged with context.
 */
export async function checkStorageAlert(
  supabase: SupabaseClient,
  userId: string,
  spaceId: string,
): Promise<void> {
  try {
    await runCheck(supabase, userId, spaceId);
  } catch (err) {
    console.error(
      `[storage-monitor] alert check failed (user=${userId} space=${spaceId}):`,
      err,
    );
  }
}

async function runCheck(
  supabase: SupabaseClient,
  userId: string,
  spaceId: string,
): Promise<void> {
  // Fresh read — the atomic RPC has already applied the delta at this point
  const { data: userData, error: userErr } = await supabase
    .from('users')
    .select('storage_used, storage_limit')
    .eq('id', userId)
    .maybeSingle();
  if (userErr) throw userErr;
  const user = userData as Pick<UserRecord, 'storage_used' | 'storage_limit'> | null;
  if (!user || user.storage_limit <= 0) return;

  const pct = (user.storage_used / user.storage_limit) * 100;

  const { data: alertData, error: alertErr } = await supabase
    .from('space_storage_alerts')
    .select('space_id, last_notified_threshold, notified_at')
    .eq('space_id', spaceId)
    .maybeSingle();
  if (alertErr) throw alertErr;
  const alert = alertData as StorageAlertRow | null;

  // Usage back under the reset line (e.g. after deletes) → re-arm both thresholds
  if (pct < RESET_BELOW_PCT) {
    if (alert?.last_notified_threshold != null) {
      const { error } = await supabase
        .from('space_storage_alerts')
        .update({ last_notified_threshold: null, updated_at: new Date().toISOString() })
        .eq('space_id', spaceId);
      if (error) throw error;
    }
    return;
  }

  const crossed =
    pct >= config.STORAGE_WARN_THRESHOLD_HIGH
      ? config.STORAGE_WARN_THRESHOLD_HIGH
      : pct >= config.STORAGE_WARN_THRESHOLD_LOW
        ? config.STORAGE_WARN_THRESHOLD_LOW
        : null;
  if (crossed === null) return;

  // Already notified at this level (or higher) since the last reset → stay quiet
  if ((alert?.last_notified_threshold ?? 0) >= crossed) return;

  // Analytics: a soft storage threshold was newly crossed (deduped by the gate
  // above, so this fires once per threshold per reset cycle). The 100%-full /
  // upload-blocked case is a separate `feature_blocked_quota` event.
  void logEvent(supabase, {
    eventType: 'storage_quota_warning_shown',
    userId,
    spaceId,
    source: 'worker',
    metadata: { threshold: crossed, pct: Math.round(pct) },
  });

  const { data: spaceData, error: spaceErr } = await supabase
    .from('spaces')
    .select('*')
    .eq('id', spaceId)
    .maybeSingle();
  if (spaceErr) throw spaceErr;
  const space = spaceData as SpaceRecord | null;
  if (!space) return;

  const ownerLineUserId = await findOwnerLineUserId(supabase, spaceId);
  if (!ownerLineUserId) {
    console.warn(`[storage-monitor] no owner found for space ${spaceId} — alert skipped`);
    return;
  }

  await addPendingNotify(ownerLineUserId, [
    { type: 'text', text: buildAlertText(crossed, space.name, user.storage_used, user.storage_limit) },
  ]);

  const now = new Date().toISOString();
  const { error: upsertErr } = await supabase
    .from('space_storage_alerts')
    .upsert({ space_id: spaceId, last_notified_threshold: crossed, notified_at: now, updated_at: now });
  if (upsertErr) throw upsertErr;
}
