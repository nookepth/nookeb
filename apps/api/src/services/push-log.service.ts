/**
 * push_log writer — one row per LINE push ATTEMPT (migration 060).
 *
 * WHAT THIS CLOSES. pushMessage() is the single choke point every push in the
 * product goes through, and until now a push left almost no trace: a console
 * line, plus — for SCHEDULED reminders only — a stamp on task_reminders. So
 * three questions had no answer anywhere:
 *
 *   * the LINE push allowance is metered and fails silently when spent, and
 *     nothing recorded what it was spent on;
 *   * push_enabled (059) suppresses pushes SILENTLY BY DESIGN — a blocked push
 *     returns normally so the reminder worker does not burn three attempts and
 *     stamp failed_at on a row nothing was wrong with. Correct, and invisible;
 *   * announcements, cancel notices and review-loop notices have no row in
 *     task_reminders at all — that table only covers scheduled shots.
 *
 * ── NEVER THROWS. Not "usually" ─────────────────────────────────────────────
 *
 * writePushLog is called from inside pushMessage(), which runs in the reminder
 * worker behind a 10/second limiter, and from a BullMQ 'failed' listener in the
 * upload worker. A rejection in either place is expensive out of all proportion
 * to the value of one log row:
 *
 *   in pushMessage  a throw would turn a DELIVERED push into a failed job,
 *                   which BullMQ retries — and the retry sends the message a
 *                   second time. A logbook that can cause duplicate messages is
 *                   worse than no logbook.
 *   in a listener   workers/index.ts turns unhandledRejection into
 *                   process.exit(1). An unavailable table would restart-loop
 *                   the worker.
 *
 * So every path here is caught and degraded to a console line. This is the same
 * fail-open posture push-flag.service.ts takes two lines earlier in the same
 * function, and for the same reason: observability must never be able to break
 * the thing it observes.
 *
 * ── The client is optional, and there is a lazy fallback ────────────────────
 *
 * Callers pass their own service-role client (all five do). When one is
 * omitted, this module falls back to its own lazy singleton rather than
 * skipping the write — a caller that forgets loses a row silently, and silent
 * gaps are exactly what this table exists to end. Lazy, never at import: this
 * module is pulled in by line.service.ts, which the webhook, every LIFF-facing
 * route and all four workers import, and constructing a client at import time
 * would open a socket in every one of them.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';

/**
 * Every call site that pushes, named. A closed union rather than a free string
 * so a new push path has to declare itself here — which is the moment someone
 * has to think about whether it should be pushing at all (CLAUDE.md rule 10:
 * reply-only is the default, push is the sanctioned exception).
 */
export type PushContext =
  | 'task_reminder'
  | 'task_notify'
  | 'diary_addon'
  | 'diary_sweep'
  | 'admin_alert';

export type PushLogStatus = 'sent' | 'failed' | 'blocked_quota' | 'blocked_flag';

export interface WritePushLogParams {
  /** Service-role client. Omitted → this module's lazy singleton. */
  supabase?: SupabaseClient | null;
  /** LINE destination id: U… user, C… group, R… room. */
  toId: string;
  context: PushContext;
  /** Task id for the task contexts; omitted for the diary sweeps and alerts. */
  refId?: string;
  messageCount: number;
  status: PushLogStatus;
  httpStatus?: number;
  error?: string;
}

export type PushTargetKind = 'user' | 'group' | 'room';

/**
 * Which kind of chat a LINE id names, from its first character.
 *
 * U = user, C = GROUP, R = ROOM. This is LINE's own convention and it matches
 * `chatScope()` in line.service.ts, which has resolved C to the /group/…
 * endpoint since the roster was built — a C id that this file called a "room"
 * would be labelled one way in push_log and fetched another way everywhere
 * else, and every group push in the product would show up mislabelled on the
 * admin page. Anything unrecognised falls to 'group', which is the CHECK's
 * safest bucket: it is what the vast majority of non-user pushes are, and an
 * unparseable id must not be able to fail the insert.
 */
export function pushTargetKind(toId: string): PushTargetKind {
  const first = toId.charAt(0);
  if (first === 'U') return 'user';
  if (first === 'R') return 'room';
  return 'group';
}

let lazyClient: SupabaseClient | null = null;

function db(supplied?: SupabaseClient | null): SupabaseClient {
  if (supplied) return supplied;
  if (!lazyClient) {
    lazyClient = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return lazyClient;
}

/** Postgres TEXT has no length limit, but an ops table does not need a stack trace. */
const ERROR_MAX_CHARS = 500;

/**
 * Record one push attempt. NEVER THROWS — see the header.
 *
 * `error` is truncated rather than rejected: the LINE error bodies this
 * receives are short JSON, but a timeout message concatenated with a stack
 * would not be, and a row that fails to insert because it was too long is a row
 * that is not there when someone needs it.
 */
export async function writePushLog(params: WritePushLogParams): Promise<void> {
  try {
    const { error } = await db(params.supabase).from('push_log').insert({
      to_id: params.toId,
      to_kind: pushTargetKind(params.toId),
      context: params.context,
      // `undefined` would be serialised as the string "undefined" by a naive
      // path; an explicit null is SQL NULL. Same handling as admin-audit's
      // before/after.
      ref_id: params.refId ?? null,
      message_count: params.messageCount,
      status: params.status,
      http_status: params.httpStatus ?? null,
      error: params.error ? params.error.slice(0, ERROR_MAX_CHARS) : null,
    });
    if (error) {
      console.warn('[push-log] insert failed — push proceeded, row lost', {
        context: params.context,
        status: params.status,
        error,
      });
    }
  } catch (err) {
    console.warn('[push-log] insert threw — push proceeded, row lost', {
      context: params.context,
      status: params.status,
      err,
    });
  }
}
