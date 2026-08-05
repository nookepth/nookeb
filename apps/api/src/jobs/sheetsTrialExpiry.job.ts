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
import {
  listExpiredTrials,
  markTrialRevoked,
  type ExpiredTrialUser,
} from '../services/sheets-trial.service';

/**
 * Users cleaned up per run. The sweep runs every 15 minutes and picks up the
 * remainder oldest-first, so a backlog drains steadily rather than one run
 * holding the membership worker (concurrency 1) for an unbounded stretch and
 * starving the quota/boost/diary sweeps behind it.
 */
const DEFAULT_BATCH_SIZE = 200;

/**
 * FIX 2 — the three outcomes of a revoke, mirrored here as a structural type.
 *
 * Declared locally rather than imported from services/google-sheets.service so
 * this module stays env-free (project rule 14): that service reads `config` at
 * import time. The literals are identical and the worker's injected function is
 * the real one, so a divergence fails to compile at the injection site.
 */
export type RevokeOutcome =
  | 'REVOKED_SUCCESS'
  | 'REVOKE_FAILED_TRANSIENT'
  | 'DECRYPT_FAILED_PERMANENT';

export interface SheetsTrialExpiryDeps {
  /**
   * Revoke the grant at Google. See RevokeOutcome — each result obliges this
   * sweep to do something different, and the third one used to be indis-
   * tinguishable from the first. Injected rather than imported so this module
   * stays env-free.
   */
  revokeGrant: (userId: string, encryptedToken: string) => Promise<RevokeOutcome>;
  /**
   * Durably record a grant that can NEVER be revoked (FIX 2), returning whether
   * it was recorded. The sweep refuses to delete the credential when this
   * answers false — see the call site.
   *
   * Optional only so tests may sweep without it; a missing recorder is treated
   * as "could not record", i.e. the safe direction.
   */
  recordOrphan?: (orphan: {
    userId: string;
    googleEmail: string | null;
    detail: string;
  }) => Promise<boolean>;
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
  /**
   * FIX 2 — the stored token would not decrypt, so the grant can never be
   * revoked. Recorded in google_grant_orphans, then the dead credential row was
   * removed and the trial claimed. Every one of these needs a human.
   */
  orphaned: number;
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
    orphaned: 0,
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
      const outcome = await cleanUpExpiredTrial(supabase, user, deps, now);
      result[outcome] += 1;
    } catch (err) {
      // Per-user isolation: this user is left unclaimed and retried next run.
      console.error(`[sheets-trial] expiry sweep failed for user ${user.id}:`, err);
    }
  }

  console.log(
    `[sheets-trial] sweep examined=${result.examined} revoked=${result.revoked} ` +
      `keptOnPlan=${result.keptOnPlan} nothingToRevoke=${result.nothingToRevoke} ` +
      `deferred=${result.deferred} orphaned=${result.orphaned}`,
  );
  return result;
}

/** Which counter a single user's cleanup lands in. */
export type TrialCleanupOutcome =
  | 'revoked'
  | 'keptOnPlan'
  | 'nothingToRevoke'
  | 'deferred'
  | 'orphaned';

/**
 * Clean up ONE expired trial: revoke the grant, destroy the credential, claim
 * the trial, notify.
 *
 * EXTRACTED SO THE ADMIN FORCE-EXPIRE CANNOT DIVERGE FROM THE SWEEP (FIX 3).
 * Before the admin surface existed, ending a trial early meant editing the
 * database by hand — which skips the upgrade check, the revoke-before-delete
 * ordering, the orphan record and the claim, i.e. every property the sweep was
 * written to guarantee. POST /admin/sheets-trial/:userId/force-expire calls
 * THIS function, so there is exactly one implementation of "end a trial" and a
 * change to it applies to both callers by construction.
 *
 * Throws on a database error; the caller decides whether that isolates one user
 * (the sweep) or fails a request (the admin route).
 */
export async function cleanUpExpiredTrial(
  supabase: SupabaseClient,
  user: ExpiredTrialUser,
  deps: SheetsTrialExpiryDeps,
  now: Date,
): Promise<TrialCleanupOutcome> {
  // ---- 1. Did they upgrade during the trial? -------------------------
  // Read from the row we already have rather than a second query: the plan
  // was selected alongside the trial columns for exactly this check.
  if (hasFeature(normalizePlan(user.plan), 'google_sheets')) {
    // Claim the trial as spent, and touch NOTHING else. Their connection is
    // now held by their plan, not by the trial.
    await markTrialRevoked(supabase, user.id, now);
    return 'keptOnPlan';
  }

  // ---- 2. Is there a credential to destroy? --------------------------
  // `google_email` rides along for FIX 2: if the token turns out to be
  // undecryptable, that address is the only thing that tells a human WHICH
  // Google account still has a live grant on it, and this row is about to
  // be deleted.
  const { data: integration, error } = await supabase
    .from('google_integrations')
    .select('encrypted_token, google_email')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw error;

  if (!integration) {
    // Never connected, or disconnected before the trial ran out. Nothing to
    // revoke and nothing was taken away, so no notice either — telling
    // someone their access was cut off when they cancelled it themselves is
    // just confusing.
    await markTrialRevoked(supabase, user.id, now);
    return 'nothingToRevoke';
  }

  // ---- 3. Revoke at Google FIRST ------------------------------------
  // Before the local delete, always: the encrypted row is the only copy of
  // the refresh token, so deleting first would leave a live grant nobody
  // can ever revoke.
  const cred = integration as { encrypted_token: string; google_email: string | null };
  const outcome = await deps.revokeGrant(user.id, cred.encrypted_token);

  if (outcome === 'REVOKE_FAILED_TRANSIENT') {
    // Transient. Leave the row AND the claim untouched so the next run
    // retries this user from the top. Access is already blocked at request
    // time, so nothing is granted by the delay.
    return 'deferred';
  }

  if (outcome === 'DECRYPT_FAILED_PERMANENT') {
    // FIX 2. This used to arrive as REVOKED_SUCCESS and fall straight
    // through to the delete below — destroying the row while the grant
    // stayed live at Google, silently, with no record of which account it
    // was on. Nothing can revoke it now, so the ONLY thing of value left is
    // a durable note that it exists.
    //
    // The record is therefore a PRECONDITION of the delete, not a
    // side-effect of it: if it cannot be written, nothing is touched and the
    // next run tries again. Retrying the revoke itself is pointless (the
    // ciphertext will not start decrypting), but retrying the RECORD is not.
    const recorded = deps.recordOrphan
      ? await deps
          .recordOrphan({
            userId: user.id,
            googleEmail: cred.google_email,
            detail: 'trial expiry sweep: stored refresh token would not decrypt',
          })
          .catch(() => false)
      : false;

    if (!recorded) {
      console.error(
        `[sheets-trial] ALERT unrevocable grant for ${user.id} could NOT be recorded — ` +
          'leaving the credential row in place and retrying next run',
      );
      return 'deferred';
    }

    const { error: orphanDeleteError } = await supabase
      .from('google_integrations')
      .delete()
      .eq('user_id', user.id);
    if (orphanDeleteError) throw orphanDeleteError;

    await markTrialRevoked(supabase, user.id, now);
    // No push. "หนูคืนสิทธิ์ที่ขอไว้กับ Google เรียบร้อย" is the one thing
    // the expiry notice says that is now false, and telling a user their
    // permission was handed back when it was not is worse than silence.
    return 'orphaned';
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
  return 'revoked';
}
