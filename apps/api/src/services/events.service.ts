import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Product-analytics event log (migration 029 / `usage_events`).
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
 * fixed-vocabulary `event_type` and small STRUCTURED numbers in `metadata`
 * (page counts, byte sizes, mime category) are stored. Never pass file names,
 * captions, OCR text, or raw message text.
 */

/** Fixed event vocabulary. Add here (and document) rather than passing strings. */
export type EventType =
  // --- LINE intent (command tapped/typed) — the top of each funnel ---
  | 'cmd_scan' // สแกน — start scan mode
  | 'cmd_merge' // รวมรูป — start merge-to-PDF mode
  | 'cmd_done' // เสร็จ — finalize a scan/merge session
  | 'cmd_cancel' // ยกเลิก
  | 'cmd_convert_arm' // แปลงไฟล์ — arm convert-to-Word
  | 'cmd_diary_arm' // ไดอารี่ — arm diary capture
  | 'cmd_help' // วิธีใช้
  | 'cmd_support' // ช่วยเหลือ / ติดต่อหนูเก็บ
  | 'cmd_referral' // referral status/redeem via chat
  // --- Worker outcomes (feature actually completed) — the bottom of each funnel ---
  | 'upload_done' // normal upload batch stored
  | 'scan_done' // merged scan/merge PDF stored
  | 'docx_done' // convert-to-Word produced a .docx
  | 'docx_failed' // convert-to-Word failed (after retries)
  | 'diary_done' // diary entry stored
  // --- Cross-cutting signals ---
  | 'feature_blocked_quota' // an action was refused because the user is over quota (buy signal)
  // --- Web ---
  | 'web_login' // dashboard login succeeded
  | 'web_search' // dashboard file search
  | 'file_download' // file downloaded (web)
  // --- Vault (ห้องนิรภัย — web-only, migration 031) ---
  | 'vault_setup' // PIN set for the first time (vault activated)
  | 'vault_unlock_failed' // wrong PIN (metadata.locked = this failure triggered a lockout)
  | 'vault_upload_done'; // vault file stored (metadata: bytes, mime)

export type EventSource = 'line' | 'web' | 'worker';

export interface LogEventInput {
  eventType: EventType;
  userId?: string | null;
  spaceId?: string | null;
  source?: EventSource;
  /** Structured numbers only — never PII / free text. */
  metadata?: Record<string, number | string | boolean>;
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
    });
  } catch {
    // Best-effort: analytics must never affect the request/job. Intentionally
    // silent — a logged error here would be noise on every write if the table
    // isn't migrated yet.
  }
}
