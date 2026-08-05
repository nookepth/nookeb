/**
 * Parked-disconnect retry — FIX 1's second half (migration 063).
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * DELETE /integrations/google now revokes the grant at Google before deleting
 * the encrypted refresh token, because that token is the ONLY thing that can
 * revoke the grant and deleting it first strands a live third-party credential
 * forever. When Google is unreachable at that moment the route cannot delete,
 * and it cannot honestly claim success either — so it PARKS the row
 * (`revoke_pending_at`) and returns 202.
 *
 * This pass is what makes that promise good. It finishes exactly what the route
 * started: revoke, then delete. Nothing else.
 *
 * ── Not the trial sweep, and deliberately not part of it ──────────────────
 *
 * It rides the SAME 15-minute membership job (the cadence is already right and a
 * second repeatable would be a second thing to forget), but it is a separate
 * function over a separate query. The trial sweep is driven by
 * `users.sheets_trial_expires_at`; this is driven by
 * `google_integrations.revoke_pending_at`, and a parked disconnect has nothing
 * to do with trials — a premium user can park one too, which is precisely the
 * case the trial sweep is written to skip.
 *
 * ── Env-free (project rule 14) ────────────────────────────────────────────
 *
 * `revokeGrant` is injected, same shape and same reason as
 * sheetsTrialExpiry.job.ts: this module stays unit-testable without an .env, a
 * network or a Google client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  listPendingRevocations,
  recordRevokeRetryFailure,
  type PendingRevocation,
} from '../services/google-sheets.service';
import type { RevokeOutcome } from './sheetsTrialExpiry.job';

/**
 * Parked rows handled per run. Small on purpose: this queue is normally EMPTY —
 * it only fills when Google's revoke endpoint is having a bad time, and a run
 * that found 50 of them is already telling us something the batch size should
 * not paper over.
 */
const DEFAULT_BATCH_SIZE = 50;

/**
 * Attempts after which a parked grant is considered stuck.
 *
 * Not a give-up threshold — nothing here ever stops retrying, because the only
 * thing that ends the retry is a successful revoke. It is a REPORTING
 * threshold: 12 attempts is three hours of a grant we hold a token for and have
 * failed to hand back, which is long past "Google had a bad minute" and worth a
 * human looking at.
 */
export const REVOKE_STUCK_AFTER_ATTEMPTS = 12;

export interface GoogleRevokeRetryDeps {
  /**
   * Revoke the grant at Google. See RevokeOutcome in sheetsTrialExpiry.job.ts —
   * each result obliges this pass to do something different.
   */
  revokeGrant: (userId: string, encryptedToken: string) => Promise<RevokeOutcome>;
  /**
   * Durably record a grant that can NEVER be revoked (FIX 2), returning whether
   * it was recorded. The row is only deleted when this answers true.
   */
  recordOrphan?: (orphan: { userId: string; detail: string }) => Promise<boolean>;
  /** Called once per row that has now been retried past the stuck threshold. */
  onStuck?: (row: PendingRevocation) => Promise<void>;
  batchSize?: number;
}

export interface GoogleRevokeRetryResult {
  /** Parked rows examined this run. */
  examined: number;
  /** Grant revoked + credential finally deleted. */
  completed: number;
  /** Still unreachable — left parked, retried next run. */
  stillPending: number;
  /** Of `stillPending`, those past REVOKE_STUCK_AFTER_ATTEMPTS. */
  stuck: number;
  /** FIX 2 — token undecryptable: recorded as an orphan, then the dead row removed. */
  orphaned: number;
  /** Migration 063 not applied; nothing was read. */
  skipped: boolean;
}

/**
 * One retry pass. Never throws for a single row's sake — one bad row must not
 * stop the rest, matching the trial sweep and the diary sweep.
 */
export async function runGoogleRevokeRetry(
  supabase: SupabaseClient,
  deps: GoogleRevokeRetryDeps,
): Promise<GoogleRevokeRetryResult> {
  const result: GoogleRevokeRetryResult = {
    examined: 0,
    completed: 0,
    stillPending: 0,
    stuck: 0,
    orphaned: 0,
    skipped: false,
  };

  const { rows, supported } = await listPendingRevocations(
    supabase,
    deps.batchSize ?? DEFAULT_BATCH_SIZE,
  );
  if (!supported) {
    result.skipped = true;
    return result;
  }
  result.examined = rows.length;

  for (const row of rows) {
    try {
      const outcome = await deps.revokeGrant(row.user_id, row.encrypted_token);

      if (outcome === 'DECRYPT_FAILED_PERMANENT') {
        // FIX 2. Retrying is pointless — the ciphertext will not start
        // decrypting — but the row must not simply vanish either. Record the
        // orphan first; only a successful record buys the right to delete.
        const recorded = deps.recordOrphan
          ? await deps
              .recordOrphan({
                userId: row.user_id,
                detail: 'parked disconnect retry: stored refresh token would not decrypt',
              })
              .catch(() => false)
          : false;

        if (!recorded) {
          console.error(
            `[google-revoke-retry] ALERT unrevocable grant for ${row.user_id} could NOT be ` +
              'recorded — leaving the row parked and retrying next run',
          );
          result.stillPending += 1;
          continue;
        }

        const { error: orphanDeleteError } = await supabase
          .from('google_integrations')
          .delete()
          .eq('user_id', row.user_id);
        if (orphanDeleteError) throw orphanDeleteError;
        result.orphaned += 1;
        continue;
      }

      if (outcome === 'REVOKE_FAILED_TRANSIENT') {
        // Still unreachable. The row stays exactly where it is — the token is
        // the only thing that can ever revoke this grant, so it survives until
        // the revoke succeeds, however many runs that takes.
        const attempts = Number(row.revoke_attempts ?? 0);
        await recordRevokeRetryFailure(
          supabase,
          row.user_id,
          attempts,
          'retry: google revoke unreachable',
        );
        result.stillPending += 1;

        if (attempts + 1 >= REVOKE_STUCK_AFTER_ATTEMPTS) {
          result.stuck += 1;
          if (deps.onStuck) {
            await deps.onStuck(row).catch((err) => {
              console.warn(`[google-revoke-retry] stuck report failed for ${row.user_id}:`, err);
            });
          }
        }
        continue;
      }

      // Revoked. NOW the credential may go — the same order the route and the
      // trial sweep use, and the reason this row was kept at all.
      const { error } = await supabase
        .from('google_integrations')
        .delete()
        .eq('user_id', row.user_id);
      if (error) throw error;
      result.completed += 1;
    } catch (err) {
      // Per-row isolation: left parked, retried next run.
      console.error(`[google-revoke-retry] failed for user ${row.user_id}:`, err);
    }
  }

  if (result.examined > 0) {
    console.log(
      `[google-revoke-retry] examined=${result.examined} completed=${result.completed} ` +
        `stillPending=${result.stillPending} stuck=${result.stuck} orphaned=${result.orphaned}`,
    );
  }
  return result;
}
