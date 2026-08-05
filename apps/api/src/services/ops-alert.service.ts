/**
 * Ops alerting — FIX 4 (and the delivery half of FIX 5).
 *
 * ── There is no Sentry and no PagerDuty in this project ───────────────────
 *
 * So "fire into the alerting system" has to mean something that actually
 * exists. Two things do:
 *
 *   1. `/admin/system` — the page an on-call person already opens when they
 *      suspect something is wrong. Backed by ops_alerts (migration 065), which
 *      is durable, listable, countable and closeable.
 *   2. A LINE push to `ADMIN_LINE_USER_ID` — the same channel upload.worker.ts
 *      already uses for a permanently-failed job. It is the only thing here
 *      that reaches a human who is not looking at a screen.
 *
 * The row is the alert; the push is the page. They are separate on purpose: a
 * push can fail, be muted by the kill switch, or exhaust the monthly quota, and
 * none of that may cost us the record.
 *
 * ── Deduped, and rate-limited, or it is not an alert ──────────────────────
 *
 * A sweep that has been down for a day raises the same condition 96 times. Sent
 * as 96 identical LINE messages that is not an alert — it is noise that trains
 * people to ignore the channel, and it burns metered push quota (rule 10). So:
 *
 *   - ops_alerts has a UNIQUE index on `key` WHERE resolved_at IS NULL, and
 *     raiseOpsAlert upserts against it. Re-raising bumps `occurrences` and
 *     `last_seen_at` on the SAME row. The dedupe is in the database because two
 *     processes can raise the same key concurrently and a read-then-insert
 *     would produce two rows.
 *   - the push is gated on `last_notified_at` being older than
 *     RENOTIFY_AFTER_MS, so a persisting condition pages at most hourly.
 *
 * ── NEVER THROWS ──────────────────────────────────────────────────────────
 *
 * Same rule as push-log and job-log (migration 060), for the same reason and
 * with a sharper edge here: the callers are a BullMQ job handler and an
 * in-process interval. A rejection inside the interval is an unhandledRejection,
 * which workers/index.ts and index.ts both turn into process.exit(1) — the
 * alerting layer taking down the service it is supposed to be watching.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';
import { pushMessage } from './line.service';

/** Do not page about the same open alert more often than this. */
const RENOTIFY_AFTER_MS = 60 * 60 * 1000;

export type AlertSeverity = 'warning' | 'critical';

export interface OpsAlertParams {
  /** Stable identity for "the same problem", e.g. 'sweep_stalled:sheets_trial_expiry'. */
  key: string;
  severity?: AlertSeverity;
  title: string;
  detail?: Record<string, unknown>;
}

interface OpenAlertRow {
  id: string;
  occurrences: number;
  last_notified_at: string | null;
  first_seen_at: string;
}

/**
 * Raise (or re-raise) an alert. NEVER THROWS.
 *
 * Returns whether the admin channel was actually paged this time — used only by
 * tests and by the caller's own logging; nothing branches on it in production.
 */
export async function raiseOpsAlert(
  supabase: SupabaseClient,
  params: OpsAlertParams,
): Promise<{ recorded: boolean; notified: boolean }> {
  const severity: AlertSeverity = params.severity ?? 'warning';
  const now = new Date();

  // The log line goes out FIRST and unconditionally. Everything below can fail
  // — a missing migration 065, a dead database, a muted push — and when it all
  // does, this is the only trace left, so it must not be downstream of any of
  // it. ERROR level so it is greppable next to the other ALERT lines.
  console.error(`[ops-alert] ${severity.toUpperCase()} ${params.key}: ${params.title}`, {
    at: now.toISOString(),
    ...(params.detail ?? {}),
  });

  let open: OpenAlertRow | null = null;
  let recorded = false;
  try {
    const { data: existing, error: readErr } = await supabase
      .from('ops_alerts')
      .select('id, occurrences, last_notified_at, first_seen_at')
      .eq('key', params.key)
      .is('resolved_at', null)
      .maybeSingle();
    if (readErr) throw readErr;
    open = (existing as OpenAlertRow | null) ?? null;

    if (open) {
      const { error } = await supabase
        .from('ops_alerts')
        .update({
          severity,
          title: params.title,
          detail: params.detail ?? null,
          last_seen_at: now.toISOString(),
          occurrences: open.occurrences + 1,
        })
        .eq('id', open.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('ops_alerts').insert({
        key: params.key,
        severity,
        title: params.title,
        detail: params.detail ?? null,
        first_seen_at: now.toISOString(),
        last_seen_at: now.toISOString(),
        occurrences: 1,
      });
      // 23505: the partial unique index fired — another process opened the same
      // alert between our read and our insert. That is the dedupe working, not
      // a failure.
      if (error && (error as { code?: string }).code !== '23505') throw error;
    }
    recorded = true;
  } catch (err) {
    console.error('[ops-alert] could not record alert (continuing to page anyway)', {
      key: params.key,
      err,
    });
  }

  // Page only on a NEW alert, or once the re-notify window has passed. When the
  // row could not be read at all we page — an alert we cannot deduplicate is
  // still better delivered than dropped.
  const lastNotified = open?.last_notified_at ? Date.parse(open.last_notified_at) : 0;
  const shouldNotify = !open || now.getTime() - lastNotified >= RENOTIFY_AFTER_MS;
  if (!shouldNotify) return { recorded, notified: false };

  const notified = await pageAdmin(supabase, severity, params, open, now);
  return { recorded, notified };
}

async function pageAdmin(
  supabase: SupabaseClient,
  severity: AlertSeverity,
  params: OpsAlertParams,
  open: OpenAlertRow | null,
  now: Date,
): Promise<boolean> {
  const adminLineUserId = config.ADMIN_LINE_USER_ID;
  if (!adminLineUserId) {
    // Not a failure — an unconfigured paging channel is a deployment choice.
    // The row and the log line are still there.
    return false;
  }

  const lines = [
    `🚨 [nookeb] ${severity === 'critical' ? 'CRITICAL' : 'WARNING'}`,
    params.title,
  ];
  if (open) {
    lines.push(`เกิดต่อเนื่องตั้งแต่ ${open.first_seen_at} (${open.occurrences + 1} ครั้ง)`);
  }
  for (const [k, v] of Object.entries(params.detail ?? {})) {
    lines.push(`${k}: ${String(v)}`);
  }
  lines.push(`${config.WEB_URL}/admin/system`);

  try {
    await pushMessage(
      adminLineUserId,
      [{ type: 'text', text: lines.join('\n') }],
      supabase,
      'admin_alert',
    );
  } catch (err) {
    console.error('[ops-alert] admin page failed', { key: params.key, err });
    return false;
  }

  // Stamped only after a push that did not throw, so a failed page is retried
  // on the next raise rather than being suppressed for an hour.
  try {
    await supabase
      .from('ops_alerts')
      .update({ last_notified_at: now.toISOString() })
      .eq('key', params.key)
      .is('resolved_at', null);
  } catch (err) {
    console.warn('[ops-alert] could not stamp last_notified_at', { key: params.key, err });
  }
  return true;
}

/**
 * Close an alert because its condition has cleared. NEVER THROWS.
 *
 * Called unconditionally on the healthy path — cheap (it matches nothing when
 * there is no open alert) and it is what makes the open list mean "still
 * broken" rather than "was broken once". An alert nobody ever closes is an
 * alert people learn to ignore.
 */
export async function resolveOpsAlert(supabase: SupabaseClient, key: string): Promise<void> {
  try {
    const { error } = await supabase
      .from('ops_alerts')
      .update({ resolved_at: new Date().toISOString() })
      .eq('key', key)
      .is('resolved_at', null);
    if (error) throw error;
  } catch (err) {
    console.warn('[ops-alert] could not resolve alert', { key, err });
  }
}

export interface OpenOpsAlert {
  key: string;
  severity: string;
  title: string;
  detail: Record<string, unknown> | null;
  first_seen_at: string;
  last_seen_at: string;
  occurrences: number;
}

/**
 * Open alerts for /admin/system. Fail-soft (empty array), per that file's read
 * contract — an ops page must render when its data source is unhappy.
 */
export async function listOpenOpsAlerts(
  supabase: SupabaseClient,
  limit = 50,
): Promise<OpenOpsAlert[]> {
  try {
    const { data, error } = await supabase
      .from('ops_alerts')
      .select('key, severity, title, detail, first_seen_at, last_seen_at, occurrences')
      .is('resolved_at', null)
      .order('last_seen_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data as OpenOpsAlert[] | null) ?? [];
  } catch (err) {
    console.warn('[ops-alert] could not list open alerts:', err);
    return [];
  }
}
