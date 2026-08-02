/**
 * หนูเก็บลองงาน — the 14-day Google Sheets trial (migration 062).
 *
 * THIS MODULE IS THE ONLY PLACE THE TRIAL IS EVER CONSULTED. Everything that
 * used to ask `planAllows(plan, 'google_sheets')` now asks resolveSheetsAccess()
 * instead, and there are exactly five such places (see the list on that
 * function). If a sixth Sheets entry point is ever added, it must come here too
 * — a route that checks the plan directly would silently refuse every trial
 * user, and a worker that does would connect them successfully and then sync
 * nothing, which is worse because it looks like it worked.
 *
 * The trial grants ONE feature flag and nothing else. It does not touch
 * `users.plan`, `subscriptions`, quotas, storage, or any other gate — a free
 * user on trial is a free user in every respect except that `google_sheets`
 * resolves true.
 *
 * ── The cutoff is enforced here, on every request ─────────────────────────
 *
 * `expires_at <= now` is compared at REQUEST TIME, on every Sheets call, which
 * is what makes "exactly 14 days, hard cutoff, no grace period" literally true.
 * The 15-minute sweep (jobs/sheetsTrialExpiry.job.ts) does NOT enforce the
 * cutoff — it cannot, since a cron is only ever as precise as its period. The
 * sweep is the JANITOR: it revokes the Google grant and deletes the credential.
 * Access stops the millisecond the trial ends; the credential is destroyed
 * within fifteen minutes of that.
 *
 * ── Fail-closed before migration 062 ──────────────────────────────────────
 *
 * Reading a column that does not exist yet reports "no trial" rather than
 * throwing. That is the safe direction and it is chosen, not incidental: an
 * un-migrated database grants nobody anything and every plan gate behaves
 * exactly as it does today. Activation is the one operation that refuses loudly
 * (503) instead of silently doing nothing.
 */

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import type { SheetsAccess, SheetsTrial } from '@nookeb/shared';
import {
  SHEETS_TRIAL_DAYS,
  hasFeature,
  normalizePlan,
  sheetsTrialExpiry,
  type Plan,
} from '../config/plans';

/** The trial columns, plus the plan they modify. One row, one round trip. */
const TRIAL_SELECT = 'plan, sheets_trial_activated_at, sheets_trial_expires_at, sheets_trial_revoked_at';

export interface SheetsTrialRow {
  plan: string | null;
  sheets_trial_activated_at: string | null;
  sheets_trial_expires_at: string | null;
  sheets_trial_revoked_at: string | null;
}

/**
 * Postgres "column does not exist" — migration 062 has not been applied.
 *
 * Matched on SQLSTATE first (PostgREST forwards it verbatim) with a message
 * fallback, because a schema-cache miss surfaces as PGRST204 with the column
 * named in the message rather than as 42703.
 */
function isMissingTrialColumn(error: PostgrestError | null): boolean {
  if (!error) return false;
  if (error.code === '42703') return true;
  return /sheets_trial_/.test(`${error.message} ${error.details ?? ''}`);
}

/** The never-activated state. Also what a pre-062 database reports. */
export const NO_TRIAL: SheetsTrial = {
  isActive: false,
  isExpired: false,
  activatedAt: null,
  expiresAt: null,
  daysRemaining: null,
};

/**
 * Row → wire shape. PURE, so the state machine is unit-testable without a
 * database (project rule 14 in spirit — this is the part worth pinning).
 *
 * Rounded UP, floored at 0: a trial with four hours left is genuinely still
 * working, so it must not read "0 วัน" next to a working connect button. A trial
 * that has ended reports 0 rather than a negative number.
 */
export function evaluateTrial(row: SheetsTrialRow | null, now: Date): SheetsTrial {
  const activatedAt = row?.sheets_trial_activated_at ?? null;
  const expiresAt = row?.sheets_trial_expires_at ?? null;
  if (!activatedAt || !expiresAt) return NO_TRIAL;

  const remainingMs = new Date(expiresAt).getTime() - now.getTime();
  const isActive = remainingMs > 0;
  return {
    isActive,
    // Never both true, and both false before activation — see the type's doc.
    isExpired: !isActive,
    activatedAt,
    expiresAt,
    daysRemaining: Math.max(0, Math.ceil(remainingMs / 86_400_000)),
  };
}

/**
 * Read the trial row. Returns `migrated: false` (and no trial) rather than
 * throwing when 062 has not been applied — see the file header.
 */
export async function readTrialRow(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ row: SheetsTrialRow | null; migrated: boolean }> {
  const { data, error } = await supabase
    .from('users')
    .select(TRIAL_SELECT)
    .eq('id', userId)
    .maybeSingle();

  if (error && isMissingTrialColumn(error)) {
    // Pre-062: fall back to the plan alone, so entitlement still resolves
    // correctly for paying users and simply never resolves true for a trial.
    const { data: planOnly } = await supabase
      .from('users')
      .select('plan')
      .eq('id', userId)
      .maybeSingle();
    return {
      row: planOnly
        ? {
            plan: (planOnly as { plan: string | null }).plan,
            sheets_trial_activated_at: null,
            sheets_trial_expires_at: null,
            sheets_trial_revoked_at: null,
          }
        : null,
      migrated: false,
    };
  }
  if (error) throw error;
  return { row: (data as SheetsTrialRow | null) ?? null, migrated: true };
}

export interface SheetsAccessResult extends SheetsAccess {
  /** The user's real plan — unchanged by the trial. */
  plan: Plan;
  trial: SheetsTrial;
  /** False when migration 062 has not been applied. */
  migrated: boolean;
}

/**
 * May this user use the Google Sheets integration right now?
 *
 * THE SINGLE ENTITLEMENT ANSWER, replacing `planAllows(plan, 'google_sheets')`
 * at all five of its call sites:
 *   1. GET  /integrations/google/auth            (planGuard → sheetsTrialGuard)
 *   2. POST /integrations/google/sync-historical  (same)
 *   3. GET  /integrations/google/callback         (the post-redirect re-check,
 *      which planGuard cannot cover because no session survives Google's
 *      redirect)
 *   4. workers/sheetsWorker.ts — the task-creator check on sheets_sync
 *   5. workers/sheetsWorker.ts — the user check on sheets_historical
 *
 * Numbers 4 and 5 are the ones that matter most and the ones a route-level
 * guard alone would miss entirely: a trial user would complete OAuth, see
 * "เชื่อมต่อแล้ว", and then watch every single sync be silently skipped.
 *
 * PLAN WINS OVER TRIAL when both apply, and the order is load-bearing rather
 * than cosmetic — `source` is what the expiry sweep uses to decide whether it
 * is safe to destroy someone's credentials.
 */
export async function resolveSheetsAccess(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date(),
): Promise<SheetsAccessResult> {
  const { row, migrated } = await readTrialRow(supabase, userId);
  const plan = normalizePlan(row?.plan ?? null);
  const trial = evaluateTrial(row, now);

  if (hasFeature(plan, 'google_sheets')) {
    return { allowed: true, source: 'plan', plan, trial, migrated };
  }
  if (trial.isActive) {
    return { allowed: true, source: 'trial', plan, trial, migrated };
  }
  return { allowed: false, source: null, plan, trial, migrated };
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export type ActivateTrialResult =
  | { ok: true; trial: SheetsTrial }
  /** Already started once. There is no reset and no extension, by design. */
  | { ok: false; reason: 'ALREADY_USED'; trial: SheetsTrial }
  /** Their plan already includes Sheets — spending the one-shot would waste it. */
  | { ok: false; reason: 'ALREADY_ENTITLED'; trial: SheetsTrial }
  /** Migration 062 has not been applied on this deployment. */
  | { ok: false; reason: 'NOT_MIGRATED'; trial: SheetsTrial };

/**
 * Start the trial. ONCE PER USER, FOREVER.
 *
 * The one-shot is enforced by a CONDITIONAL UPDATE — `.is(activated_at, null)`
 * in the WHERE, not a read-then-write — so two concurrent taps of the button
 * cannot both succeed. Postgres serialises them and the loser updates zero rows,
 * which is reported as ALREADY_USED rather than as a fresh fourteen days. Same
 * discipline as the `session_version` guard in the suspension path.
 *
 * ALREADY_ENTITLED is refused rather than allowed-and-ignored on purpose. A
 * premium user gets nothing from a trial of a feature they already have, and
 * silently burning their single lifetime activation would leave them with
 * nothing on the day they downgrade — which is precisely when a trial is worth
 * having.
 */
export async function activateTrial(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date(),
): Promise<ActivateTrialResult> {
  const access = await resolveSheetsAccess(supabase, userId, now);

  if (!access.migrated) {
    return { ok: false, reason: 'NOT_MIGRATED', trial: NO_TRIAL };
  }
  if (hasFeature(access.plan, 'google_sheets')) {
    return { ok: false, reason: 'ALREADY_ENTITLED', trial: access.trial };
  }
  if (access.trial.activatedAt) {
    return { ok: false, reason: 'ALREADY_USED', trial: access.trial };
  }

  const activatedAt = now.toISOString();
  const expiresAt = sheetsTrialExpiry(now).toISOString();

  const { data, error } = await supabase
    .from('users')
    .update({
      sheets_trial_activated_at: activatedAt,
      sheets_trial_expires_at: expiresAt,
      // Belt and braces: a row can only reach here with this already NULL, but
      // stating it means a hypothetical re-activation could never inherit a
      // stale revocation stamp and be skipped by the sweep.
      sheets_trial_revoked_at: null,
    })
    .eq('id', userId)
    // THE ONE-SHOT. Do not remove: without it this is a read-then-write and two
    // taps 5 ms apart both get fourteen days.
    .is('sheets_trial_activated_at', null)
    .select(TRIAL_SELECT)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    // Lost the race, or the row vanished. Re-read for the authoritative state.
    const after = await resolveSheetsAccess(supabase, userId, now);
    return { ok: false, reason: 'ALREADY_USED', trial: after.trial };
  }
  return { ok: true, trial: evaluateTrial(data as SheetsTrialRow, now) };
}

// ---------------------------------------------------------------------------
// Expiry sweep support
// ---------------------------------------------------------------------------

export interface ExpiredTrialUser {
  id: string;
  line_user_id: string | null;
  plan: string | null;
  sheets_trial_expires_at: string;
}

/**
 * Trials that have ended and have NOT yet been cleaned up.
 *
 * NO TIME WINDOW, and that is the whole point (see migration 062's header). The
 * spec's `expires_at > NOW() - INTERVAL '15 minutes'` bound meant one missed run
 * — a deploy, a restart, an exhausted retry — left that user's Google grant
 * alive forever, because the next run would no longer see them. `revoked_at IS
 * NULL` makes the query "everything still outstanding", so the sweep catches up
 * on whatever it missed however long ago it missed it.
 *
 * Bounded per run so one sweep cannot run unboundedly long; the remainder is
 * picked up 15 minutes later, oldest first.
 */
export async function listExpiredTrials(
  supabase: SupabaseClient,
  now: Date,
  limit: number,
): Promise<{ users: ExpiredTrialUser[]; migrated: boolean }> {
  const { data, error } = await supabase
    .from('users')
    .select('id, line_user_id, plan, sheets_trial_expires_at')
    .lte('sheets_trial_expires_at', now.toISOString())
    .is('sheets_trial_revoked_at', null)
    .order('sheets_trial_expires_at', { ascending: true })
    .limit(limit);

  if (error && isMissingTrialColumn(error)) return { users: [], migrated: false };
  if (error) throw error;
  return { users: (data as ExpiredTrialUser[] | null) ?? [], migrated: true };
}

/**
 * Claim an expired trial as cleaned up.
 *
 * Stamped AFTER the Google grant is revoked and the credential row deleted,
 * never before: if the stamp went first and the revoke then failed, that user
 * would drop out of the sweep's query permanently with a live token — the exact
 * failure the claim column exists to prevent. Doing it in this order means a
 * failed revoke is simply retried on the next run, and both steps are
 * idempotent (Google rejects an already-revoked token, deleting an absent row
 * is a no-op).
 */
export async function markTrialRevoked(
  supabase: SupabaseClient,
  userId: string,
  now: Date,
): Promise<void> {
  const { error } = await supabase
    .from('users')
    .update({ sheets_trial_revoked_at: now.toISOString() })
    .eq('id', userId)
    .is('sheets_trial_revoked_at', null);
  if (error) throw error;
}

/** Re-exported so routes and the web serve one number, never a literal. */
export { SHEETS_TRIAL_DAYS };
