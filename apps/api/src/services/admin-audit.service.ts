/**
 * admin_audit_log writer — the accountability half of every TIER 2 admin write.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: no privileged admin write lands without
 * a row here. Not "usually", not "best effort" — an unaudited change to someone
 * else's plan, storage ceiling, quota counter or session validity is worse than
 * a change that failed, because the failed one is visible and the unaudited one
 * is not.
 *
 * ── Two functions, and why there are two ──────────────────────────────────────
 *
 * The brief asked for a recorder that NEVER THROWS and, in the same breath, for
 * a failed audit write to surface as a 500 so the caller can roll back. A
 * single `Promise<void>` cannot do both: if it never throws and returns nothing,
 * the caller has no way to learn it failed. So the two halves are split:
 *
 *   recordAdminAction()   never throws. For a write that is already irreversible
 *                         and where a lost audit row must not also lose the
 *                         admin's work. Nothing in TIER 2 uses it today; it is
 *                         the escape hatch, and reaching for it should be a
 *                         deliberate, commented decision.
 *
 *   requireAdminAction()  awaits the same insert and THROWS AdminAuditError when
 *                         it fails. Every TIER 2 route uses this one. Fastify's
 *                         root error handler turns it into a 500, and each route
 *                         reverts its own write first — see the rollback note.
 *
 * ── On "the same DB transaction" ─────────────────────────────────────────────
 *
 * There isn't one, and there cannot be. The API talks to Postgres through
 * PostgREST (@supabase/supabase-js), which has no multi-statement transaction:
 * every .update()/.insert() is its own committed statement. A genuine
 * write+audit atom would need a Postgres function per action, i.e. eight more
 * RPCs in a migration, and the project's rule is that schema changes are
 * hand-applied migration files — the failure mode of an unapplied one is worse
 * than the failure mode this compensating design has.
 *
 * So TIER 2 uses COMPENSATION, not atomicity, and the routes are written to
 * make the compensation trivially correct:
 *
 *   reversible writes (plan, storage override, quota reset, session revoke,
 *   reminder cancel, ticket update) — read `before`, write, audit, and on an
 *   audit failure write `before` back and 500. The revert is a plain UPDATE
 *   with the same values that were just read.
 *
 *   irreversible writes (BullMQ job retry / remove) — AUDIT FIRST, then act. A
 *   removed job cannot be put back, so the ordering is inverted: the audit row
 *   records an authorised action about to be taken, and a failed insert means
 *   nothing happened at all. The cost is that a crash between the two leaves an
 *   audit row for an action that did not occur, which is the safe direction to
 *   be wrong in.
 *
 * A compensating revert can itself fail (the same DB is unhappy). That case is
 * logged loudly with both values and still 500s; it is the one hole, it is
 * narrow, and the log line is the recovery path.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Thrown by requireAdminAction when the audit row could not be written. */
export class AdminAuditError extends Error {
  /** Fastify reads this to choose the status code. 500: the admin must retry. */
  readonly statusCode = 500;

  constructor(
    readonly action: string,
    /** Named `sourceError`, not `cause`: Error already declares `cause`, and
     *  shadowing it with a parameter property needs an `override` modifier that
     *  buys nothing here. */
    readonly sourceError: unknown,
  ) {
    super(`admin audit write failed for action "${action}"`);
    this.name = 'AdminAuditError';
  }
}

export interface AdminActionParams {
  supabase: SupabaseClient;
  /** LINE user id from the verified session — never a users.id (see migration 059). */
  adminLineId: string;
  /** Stable snake_case verb, e.g. 'user_plan_change'. Treated as data, not schema. */
  action: string;
  /** What kind of thing was acted on: 'user' | 'task' | 'job' | 'setting' | 'ticket'. */
  targetType?: string;
  targetId?: string;
  /** State BEFORE the write — only the fields the action touched, never a whole row. */
  before?: unknown;
  /** State AFTER the write. */
  after?: unknown;
}

/**
 * The one place the row is actually built and inserted.
 *
 * `before`/`after` are passed through as-is for JSONB. `undefined` becomes SQL
 * NULL rather than the JSON string "undefined", which is what a naive
 * JSON.stringify round-trip would produce.
 */
async function insertAuditRow(params: AdminActionParams): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const { error } = await params.supabase.from('admin_audit_log').insert({
    admin_line_id: params.adminLineId,
    action: params.action,
    target_type: params.targetType ?? null,
    target_id: params.targetId ?? null,
    before: params.before === undefined ? null : params.before,
    after: params.after === undefined ? null : params.after,
  });
  return error ? { ok: false, error } : { ok: true };
}

/**
 * Record an admin action. NEVER THROWS.
 *
 * Use this only where losing the audit row is strictly better than losing the
 * admin's work, and say why at the call site. Every TIER 2 route uses
 * {@link requireAdminAction} instead — silence here is exactly the gap the
 * audit log exists to close, so it is logged at error level with the full
 * payload, which is the only remaining trace.
 */
export async function recordAdminAction(params: AdminActionParams): Promise<void> {
  try {
    const res = await insertAuditRow(params);
    if (!res.ok) {
      console.error('[admin-audit] INSERT FAILED — action is now unaudited', {
        action: params.action,
        adminLineId: params.adminLineId,
        targetType: params.targetType,
        targetId: params.targetId,
        error: res.error,
      });
    }
  } catch (err) {
    console.error('[admin-audit] INSERT THREW — action is now unaudited', {
      action: params.action,
      adminLineId: params.adminLineId,
      targetId: params.targetId,
      err,
    });
  }
}

/**
 * Record an admin action, or throw {@link AdminAuditError}.
 *
 * The default for every privileged write. The caller must have already reverted
 * (or not yet performed) the write it is auditing by the time this rejects —
 * see the compensation contract in the file header.
 */
export async function requireAdminAction(params: AdminActionParams): Promise<void> {
  let res: { ok: true } | { ok: false; error: unknown };
  try {
    res = await insertAuditRow(params);
  } catch (err) {
    throw new AdminAuditError(params.action, err);
  }
  if (!res.ok) throw new AdminAuditError(params.action, res.error);
}
