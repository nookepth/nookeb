/**
 * หนูเก็บลองงาน expiry sweep (migration 062) — the JANITOR, not the gate.
 *
 * ── This job does NOT enforce the cutoff ──────────────────────────────────
 *
 * Access stops the instant `users.sheets_trial_expires_at` passes, because
 * resolveSheetsAccess compares it on EVERY Sheets request (routes and worker
 * alike). That is what makes "exactly 14 days, hard cutoff, no grace period"
 * literally true — a cron can only ever be as precise as its period, so a job
 * that ran every 15 minutes and was the only gate would hand out up to 15
 * minutes of free access.
 *
 * What this job does is destroy the credential: revoke the grant at Google and
 * delete the encrypted refresh token. Access is already gone by the time it
 * runs; this closes the window in which we still HOLD a token we have no right
 * to use.
 *
 * ── No time window, and a claim column ────────────────────────────────────
 *
 * The driving query is `expires_at <= NOW() AND revoked_at IS NULL` — see
 * listExpiredTrials. The spec's windowed version would have dropped any user
 * missed by a single run (a deploy, a restart, an exhausted retry) out of the
 * query forever, leaving their Google grant alive with nobody ever looking at
 * it again. Everything below is idempotent and re-entrant so this can be re-run
 * at any time from any state.
 *
 * ── The upgrade case, which is a data-loss bug if missed ──────────────────
 *
 * A trial user who BUYS premium mid-trial still has an expired trial row. The
 * naive sweep revokes their tokens and deletes their integration — destroying a
 * paying customer's working connection as a side effect of a trial they no
 * longer need. `source === 'plan'` is checked per user, immediately before
 * revoking, and such users are claimed without touching a single credential.
 *
 * ── Env-free (project rule 14) ────────────────────────────────────────────
 *
 * Everything that needs config — revoking at Google, pushing to LINE, the web
 * URL — arrives through `deps`, supplied by jobs/membership.worker.ts. Same
 * shape as diaryReminder.job.ts, and for the same reason: this module stays
 * unit-testable without an .env, a Redis client or a network.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { PLAN_DISPLAY_NAME, SHEETS_TRIAL_DISPLAY_NAME, hasFeature, normalizePlan } from '../config/plans';
import { listExpiredTrials, markTrialRevoked } from '../services/sheets-trial.service';

/**
 * Users cleaned up per run. The sweep runs every 15 minutes and picks up the
 * remainder oldest-first, so a backlog drains steadily rather than one run
 * holding the membership worker (concurrency 1) for an unbounded stretch and
 * starving the quota/boost/diary sweeps behind it.
 */
const DEFAULT_BATCH_SIZE = 200;

export interface SheetsTrialExpiryDeps {
  /**
   * Revoke the grant at Google. `true` = gone (including "already invalid"),
   * `false` = transient failure, leave the credential and retry next run.
   * Injected rather than imported so this module stays env-free.
   */
  revokeGrant: (userId: string, encryptedToken: string) => Promise<boolean>;
  /** LINE push. Optional: omit to sweep silently (tests, or a muted rollout). */
  push?: (lineUserId: string, text: string) => Promise<void>;
  /**
   * Drop the user's queued historical backfill, if one is waiting. Optional and
   * best-effort — it is a tidiness measure, not a security boundary: the worker
   * re-checks entitlement on every job, so a backfill that slips through is
   * refused there anyway.
   */
  cancelPendingSync?: (userId: string) => Promise<void>;
  /** For the upgrade link in the notice. */
  webUrl?: string;
  now?: Date;
  batchSize?: number;
}

export interface SheetsTrialExpiryResult {
  /** Rows matched this run. */
  examined: number;
  /** Grant revoked + credential deleted + claimed. */
  revoked: number;
  /** Claimed without touching credentials — the user is on a plan that includes Sheets. */
  keptOnPlan: number;
  /** Claimed with nothing to revoke — never connected, or disconnected already. */
  nothingToRevoke: number;
  /** Left for the next run — Google's revoke endpoint was unreachable. */
  deferred: number;
  /** Migration 062 not applied; nothing was read. */
  skipped: boolean;
}

/**
 * The notice. Plain text, one message, no Flex — the cheapest possible push,
 * matching the diary sweep's reasoning (rule 10: reply-only is the default and
 * push is metered).
 *
 * It says three things the user needs and would otherwise have to guess at:
 * that syncing has stopped, that the permission they granted has been handed
 * BACK rather than quietly kept, and that their spreadsheet is untouched. The
 * last one matters most — the sheet is the user's own document, it is never
 * deleted, and someone who has just been told "หมดอายุ" will assume otherwise.
 */
export function expiryNoticeText(webUrl?: string): string {
  const lines = [
    `${SHEETS_TRIAL_DISPLAY_NAME} ครบ 14 วันแล้วน้า`,
    '',
    `หนูหยุด sync งานไป Google Sheet ให้แล้ว และคืนสิทธิ์ที่ขอไว้กับ Google เรียบร้อย — Sheet เดิมของพี่ยังอยู่ครบทุกแถว ไม่ได้หายไปไหนน้า`,
    '',
    `อยากให้หนู sync ต่อ อัปเกรดเป็นแพ็กเกจ ${PLAN_DISPLAY_NAME.premium} ได้เลย`,
  ];
  if (webUrl) lines.push(`${webUrl}/dashboard/settings`);
  return lines.join('\n');
}

/**
 * One sweep. Never throws for a single user's sake — one unreachable Google or
 * one bad recipient must not stop the rest of the batch, exactly as in the
 * diary sweep.
 */
export async function runSheetsTrialExpiry(
  supabase: SupabaseClient,
  deps: SheetsTrialExpiryDeps,
): Promise<SheetsTrialExpiryResult> {
  const now = deps.now ?? new Date();
  const result: SheetsTrialExpiryResult = {
    examined: 0,
    revoked: 0,
    keptOnPlan: 0,
    nothingToRevoke: 0,
    deferred: 0,
    skipped: false,
  };

  const { users, migrated } = await listExpiredTrials(
    supabase,
    now,
    deps.batchSize ?? DEFAULT_BATCH_SIZE,
  );
  if (!migrated) {
    result.skipped = true;
    return result;
  }
  result.examined = users.length;

  for (const user of users) {
    try {
      // ---- 1. Did they upgrade during the trial? -------------------------
      // Read from the row we already have rather than a second query: the plan
      // was selected alongside the trial columns for exactly this check.
      if (hasFeature(normalizePlan(user.plan), 'google_sheets')) {
        // Claim the trial as spent, and touch NOTHING else. Their connection is
        // now held by their plan, not by the trial.
        await markTrialRevoked(supabase, user.id, now);
        result.keptOnPlan += 1;
        continue;
      }

      // ---- 2. Is there a credential to destroy? --------------------------
      const { data: integration, error } = await supabase
        .from('google_integrations')
        .select('encrypted_token')
        .eq('user_id', user.id)
        .maybeSingle();
      if (error) throw error;

      if (!integration) {
        // Never connected, or disconnected before the trial ran out. Nothing to
        // revoke and nothing was taken away, so no notice either — telling
        // someone their access was cut off when they cancelled it themselves is
        // just confusing.
        await markTrialRevoked(supabase, user.id, now);
        result.nothingToRevoke += 1;
        continue;
      }

      // ---- 3. Revoke at Google FIRST ------------------------------------
      // Before the local delete, always: the encrypted row is the only copy of
      // the refresh token, so deleting first would leave a live grant nobody
      // can ever revoke.
      const gone = await deps.revokeGrant(
        user.id,
        (integration as { encrypted_token: string }).encrypted_token,
      );
      if (!gone) {
        // Transient. Leave the row AND the claim untouched so the next run
        // retries this user from the top. Access is already blocked at request
        // time, so nothing is granted by the delay.
        result.deferred += 1;
        continue;
      }

      // ---- 4. Delete the credential -------------------------------------
      // A HARD delete, deliberately, and consistent with how a manual
      // disconnect already behaves (deleteIntegration in
      // google-sheets.service.ts). Project rule 6's soft-delete exists to keep
      // the USER's content restorable; this row is a third-party credential,
      // and a revoked token kept as a tombstone is pure liability with nothing
      // to restore. The user's spreadsheet and tasks are untouched.
      const { error: deleteError } = await supabase
        .from('google_integrations')
        .delete()
        .eq('user_id', user.id);
      if (deleteError) throw deleteError;

      // ---- 5. Claim, then notify ----------------------------------------
      await markTrialRevoked(supabase, user.id, now);
      result.revoked += 1;

      // Cancel any queued backfill for this user. Ordinary `sheets_sync` jobs
      // need no cancelling — the worker re-resolves entitlement per job and
      // stands down, which also covers a job that is already ACTIVE and
      // therefore beyond cancelling anyway.
      if (deps.cancelPendingSync) {
        await deps.cancelPendingSync(user.id).catch((err) => {
          console.warn(`[sheets-trial] could not cancel queued sync for ${user.id}:`, err);
        });
      }

      // The push goes LAST and its failure is swallowed. It runs after the
      // claim on purpose: a throw here would fail the BullMQ job, and the retry
      // would re-run a user who is already claimed — so at worst a notice is
      // lost, never a revocation repeated or a message sent twice.
      if (deps.push && user.line_user_id) {
        await deps
          .push(user.line_user_id, expiryNoticeText(deps.webUrl))
          .catch((err) => {
            console.warn(`[sheets-trial] expiry notice failed for ${user.id}:`, err);
          });
      }
    } catch (err) {
      // Per-user isolation: this user is left unclaimed and retried next run.
      console.error(`[sheets-trial] expiry sweep failed for user ${user.id}:`, err);
    }
  }

  console.log(
    `[sheets-trial] sweep examined=${result.examined} revoked=${result.revoked} ` +
      `keptOnPlan=${result.keptOnPlan} nothingToRevoke=${result.nothingToRevoke} ` +
      `deferred=${result.deferred}`,
  );
  return result;
}
