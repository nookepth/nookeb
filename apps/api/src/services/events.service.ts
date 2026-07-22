import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Product-analytics event log (migration 029 / `usage_events`, +client
 * dimensions in migration 041).
 *
 * This is the single place the app records "who used WHAT" — the intent and
 * outcome signals the files/storage tables can't express (a stored file doesn't
 * say whether it came from a scan, a convert, or a plain upload, and an
 * abandoned funnel leaves no file at all). The admin dashboard reads it back
 * through the `admin_*` RPCs.
 *
 * HARD RULE: logging is best-effort and MUST NOT affect the caller. Every write
 * goes through `logEvent`, which never throws and never blocks a user flow —
 * the LINE webhook's 1-second budget and every worker job stay untouched even
 * if the events table is missing or Supabase is down. Callers use it as
 * `void logEvent(...)` (fire-and-forget) and never await it on a hot path.
 *
 * PRIVACY (user files are private — the product's core promise): only a
 * fixed-vocabulary `event_type` and small STRUCTURED numbers/short slugs in
 * `metadata` (page counts, byte sizes, mime category) are stored. Never pass
 * file names, captions, OCR text, or raw message text. Client-originated events
 * arrive through POST /api/events/track, which re-validates the name against
 * CLIENT_TRACKABLE_EVENTS and sanitises the payload before calling this — the
 * client never writes usage_events directly.
 */

/**
 * Fixed event vocabulary — the runtime source of truth. `EventType` is derived
 * from it so the TS union and the runtime whitelist can never drift. Add here
 * (and document) rather than passing raw strings.
 *
 * NOTE (migration reuse decision, Task 2): where a spec event overlaps an
 * existing one we KEEP the existing name and enrich its metadata rather than
 * minting a duplicate — file_upload=upload_done, diary_post=diary_done,
 * gift_box_create=box_created, gift_box_open_by_recipient=box_viewed,
 * trash_restore=file_restored, trash_permanent_delete=file_purged_manual,
 * word_convert=docx_done/docx_failed, vault_pin_fail_count=vault_unlock_failed.
 */
export const EVENT_TYPES = [
  // --- LINE intent (command tapped/typed) — the top of each funnel ---
  'cmd_scan', // สแกน — start scan mode
  'cmd_merge', // รวมรูป — start merge-to-PDF mode
  'cmd_pdf_merge', // รวมไฟล์ — start PDF-merge mode (migration 044)
  'cmd_done', // เสร็จ — finalize a scan/merge session
  'cmd_cancel', // ยกเลิก
  'cmd_convert_arm', // แปลงไฟล์ — arm convert-to-Word
  'cmd_diary_arm', // ไดอารี่ — arm diary capture
  'cmd_help', // วิธีใช้
  'cmd_support', // ช่วยเหลือ / ติดต่อหนูเก็บ
  'cmd_referral', // referral status/redeem via chat
  // --- Worker outcomes (feature actually completed) — the bottom of each funnel ---
  'upload_done', // normal upload batch stored (= spec's file_upload; metadata enriched)
  'scan_done', // merged scan/merge PDF stored
  'docx_done', // convert-to-Word produced a .docx (= spec's word_convert success)
  'docx_failed', // convert-to-Word failed after retries (= spec's word_convert failure)
  'diary_done', // diary entry stored (= spec's diary_post)
  'diary_streak_break', // a new entry landed after a gap — the prior streak ended
  // --- Cross-cutting signals ---
  'feature_blocked_quota', // an action refused because over quota (100% — buy signal)
  'storage_quota_warning_shown', // storage crossed a soft threshold (metadata.threshold = 80|100)
  // --- Web ---
  'web_login', // dashboard login succeeded
  'web_search', // dashboard file search
  'file_download', // file downloaded (web)
  // --- ถังขยะ (Trash Bin — web-only, migration 032) ---
  'file_restored', // file restored from trash (= spec's trash_restore; metadata: bytes)
  'file_purged_manual', // user-triggered permanent delete (= spec's trash_permanent_delete)
  // --- Vault (ห้องนิรภัย — web-only, migration 031) ---
  'vault_setup', // PIN set for the first time (vault activated)
  'vault_open', // vault unlocked successfully (PIN accepted)
  'vault_unlock_failed', // wrong PIN (= spec's vault_pin_fail_count; metadata.locked = lockout hit)
  'vault_upload_done', // vault file stored (metadata: bytes, mime)
  // --- กล่องของขวัญ (Legacy Box — web-only, migration 033) ---
  'box_created', // legacy box published (= spec's gift_box_create; metadata: photos, bytes)
  'box_viewed', // public open page loaded (= spec's gift_box_open_by_recipient; user_id = OWNER)
  'box_deleted', // legacy box soft-deleted by its owner (metadata: bytes)
  // --- Referral (migrations 010/030) ---
  'referral_code_entered', // a referral code was submitted for redemption (attempt)
  'referral_code_activated', // redemption succeeded (bonus granted) — distinct from entry
  // --- ระบบตามงาน (Task Manager — LIFF, migration 036) ---
  'task_create_start', // create flow opened
  'task_create_submit', // task successfully created (metadata: task_type, assignee_count, has_deadline)
  'task_view', // a task detail page was viewed
  'task_mark_done', // an assignee marked their item done (metadata: time_to_complete seconds)
  'task_ics_download', // "บันทึกลงปฏิทิน" tapped
  'task_repeat_view', // a recurring task was viewed
  'task_export', // tasks exported to .xlsx (metadata: rows, filtered)
  // --- Pro fake-door demand test (migrations 040/041) ---
  'pro_interest_view', // a Pro lock modal was shown (metadata: feature_id)
  'pro_interest_click', // "แจ้งเตือนฉัน" tapped (metadata: feature_id)
  'pro_interest_dismiss', // the modal was dismissed without notifying (metadata: feature_id)
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * The subset of events a browser/LIFF client is allowed to write through
 * POST /api/events/track. Everything else is server-authoritative (worker
 * outcomes, web_login, box_created, task_create_submit, ...) and is logged
 * directly from the route/worker that owns the action — a client must never be
 * able to forge those. Client events are the pure UI signals that have no
 * server round-trip of their own (a modal impression, a page view) plus the
 * demand-test taps.
 */
export const CLIENT_TRACKABLE_EVENTS = new Set<EventType>([
  'pro_interest_view',
  'pro_interest_click',
  'pro_interest_dismiss',
  'task_create_start',
  'task_view',
  'task_repeat_view',
  'task_ics_download',
]);

export function isClientTrackableEvent(name: string): name is EventType {
  return CLIENT_TRACKABLE_EVENTS.has(name as EventType);
}

export type EventSource = 'line' | 'web' | 'worker';

/** 'free' | 'pro' snapshot at event time (users.plan 'team' collapses to 'pro'). */
export type PlanTier = 'free' | 'pro';

/** Map the raw users.plan value to the two-value plan_tier the schema stores. */
export function toPlanTier(plan: string | null | undefined): PlanTier | null {
  if (!plan) return null;
  return plan === 'free' ? 'free' : 'pro';
}

export interface LogEventInput {
  eventType: EventType;
  userId?: string | null;
  spaceId?: string | null;
  source?: EventSource;
  /** Structured numbers / short slugs only — never PII / free text. */
  metadata?: Record<string, number | string | boolean>;
  /** migration 041 dimensions (all nullable) */
  sessionId?: string | null;
  planTier?: PlanTier | null;
  entryChannel?: string | null;
}

/**
 * Insert one analytics event. Never throws — swallows every error (missing
 * table, network, etc.) so a logging failure can never break a user flow or
 * trigger a job retry. Returns a promise you can ignore: `void logEvent(...)`.
 */
export async function logEvent(
  supabase: SupabaseClient,
  input: LogEventInput,
): Promise<void> {
  try {
    await supabase.from('usage_events').insert({
      user_id: input.userId ?? null,
      space_id: input.spaceId ?? null,
      event_type: input.eventType,
      source: input.source ?? 'line',
      metadata: input.metadata ?? {},
      session_id: input.sessionId ?? null,
      plan_tier: input.planTier ?? null,
      entry_channel: input.entryChannel ?? null,
    });
  } catch {
    // Best-effort: analytics must never affect the request/job. Intentionally
    // silent — a logged error here would be noise on every write if the table
    // isn't migrated yet.
  }
}
