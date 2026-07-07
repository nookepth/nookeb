import type { SupabaseClient } from '@supabase/supabase-js';
import type { FileRecord, FileScanStatus, LineSource, SpaceRecord, UserRecord } from '@nookeb/shared';
import { config } from '../config';
import { generateReferralCode } from './referral.service';
import { addMember } from './space.service';
import { checkStorageAlert } from './storage-monitor.service';

/** Postgres unique_violation — creation races resolved by re-selecting. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * A file the pipeline refused to store (size cap, malware). Carries the exact
 * LINE message to show the sender. Handlers must NOT retry this error — the
 * rejection is deterministic.
 */
export class FileRejectedError extends Error {
  constructor(
    message: string,
    public readonly userMessage: string,
  ) {
    super(message);
    this.name = 'FileRejectedError';
  }
}

/** True if `bytes` is within the per-file hard cap (MAX_FILE_SIZE_BYTES, default 1 GB). */
export function checkFileSizeLimit(bytes: number, _filename?: string): boolean {
  return bytes <= config.MAX_FILE_SIZE_BYTES;
}

/** Find or create the user + personal space for a LINE user. */
export async function ensureUserAndSpace(
  supabase: SupabaseClient,
  lineUserId: string,
  displayName?: string,
  pictureUrl?: string,
): Promise<{ user: UserRecord; space: SpaceRecord }> {
  const { data: existing, error: findErr } = await supabase
    .from('users')
    .select('*')
    .eq('line_user_id', lineUserId)
    .maybeSingle();
  if (findErr) throw findErr;

  let user = existing as UserRecord | null;
  if (!user) {
    const { data: created, error: createErr } = await supabase
      .from('users')
      .insert({
        line_user_id: lineUserId,
        display_name: displayName ?? null,
        picture_url: pictureUrl ?? null,
        storage_limit: config.DEFAULT_STORAGE_LIMIT,
      })
      .select('*')
      .single();
    if (createErr) {
      // Concurrent webhook events for a brand-new user both pass the find and
      // both INSERT; users.line_user_id is UNIQUE, so the loser re-selects the
      // row the winner just created instead of failing the event (FIX #4).
      if (createErr.code !== PG_UNIQUE_VIOLATION) throw createErr;
      const { data: raced, error: racedErr } = await supabase
        .from('users')
        .select('*')
        .eq('line_user_id', lineUserId)
        .maybeSingle();
      if (racedErr) throw racedErr;
      if (!raced) throw createErr; // 23505 but no row — genuinely unexpected
      user = raced as UserRecord;
    } else {
      user = created as UserRecord;
    }
  }

  // Every user carries a referral code; assign one to new users AND backfill
  // pre-migration-010 users. Idempotent (only fills a NULL column) and
  // best-effort — a failure here (e.g. migration 010 not applied yet) must not
  // break login/upload.
  if (!user.referral_code) {
    try {
      user.referral_code = await generateReferralCode(supabase, user.id);
    } catch {
      // non-fatal — the code is assigned lazily by getReferralStatus later
    }
  }

  const { data: memberRows, error: memberErr } = await supabase
    .from('space_members')
    .select('space_id, spaces!inner(*)')
    .eq('user_id', user.id)
    .eq('spaces.type', 'personal')
    .limit(1);
  if (memberErr) throw memberErr;

  const memberRow = memberRows?.[0] as { spaces: SpaceRecord } | undefined;
  if (memberRow) {
    return { user, space: memberRow.spaces };
  }

  const { data: space, error: spaceErr } = await supabase
    .from('spaces')
    .insert({ name: user.display_name ? `คลังของ ${user.display_name}` : 'My Space', owner_id: user.id, type: 'personal' })
    .select('*')
    .single();
  if (spaceErr) {
    // Lost the personal-space creation race (uq_spaces_personal_owner,
    // migration 016) — use the space the winner just inserted (FIX #4).
    if (spaceErr.code !== PG_UNIQUE_VIOLATION) throw spaceErr;
    const { data: raced, error: racedErr } = await supabase
      .from('spaces')
      .select('*')
      .eq('owner_id', user.id)
      .eq('type', 'personal')
      .maybeSingle();
    if (racedErr) throw racedErr;
    if (!raced) throw spaceErr; // 23505 but no row — genuinely unexpected
    await addMember(supabase, (raced as SpaceRecord).id, user.id, 'owner');
    return { user, space: raced as SpaceRecord };
  }

  // addMember tolerates the membership-insert race the same way (23505 = the
  // concurrent loser already joined us to this space — fine).
  await addMember(supabase, (space as SpaceRecord).id, user.id, 'owner');

  return { user, space: space as SpaceRecord };
}

export interface CreateFileInput {
  id: string;
  spaceId: string;
  /** null for a file stored to a team-bound group space by a non-team-member —
   * they get no dashboard ownership (same convention as legacy unowned rows). */
  uploadedBy: string | null;
  originalName: string;
  mimeType: string;
  fileSize: number;
  extension: string | null;
  r2Key: string;
  lineMessageId: string | null;
  lineSource: LineSource | null;
  lineGroupId: string | null;
  /** virus-scan outcome (null when scanning is disabled or N/A, e.g. scan PDFs) */
  scanStatus?: FileScanStatus | null;
  /** owning team (LINE group bound to a team) — file is charged to the TEAM quota */
  teamId?: string | null;
  /**
   * Quota ledger charged for this file (migration 015). The DB default is
   * 'personal', so only 'team' needs to be sent explicitly — which also keeps
   * personal inserts working if migration 015 isn't applied yet.
   */
  chargedTo?: 'personal' | 'team';
  /** team whose quota was charged (required when chargedTo = 'team') */
  chargedTeamId?: string | null;
}

/**
 * Find the single LIVE (not soft-deleted) file row for a LINE message id, if any.
 * Backs the upload idempotency guard (migration 022): a batch retry or LINE webhook
 * redelivery must recover the already-stored file instead of storing a duplicate.
 * Returns null when `lineMessageId` maps to no live row. Server-generated files
 * (merged scan PDFs) carry a NULL line_message_id and are never matched here.
 */
export async function findLiveFileByLineMessageId(
  supabase: SupabaseClient,
  lineMessageId: string,
): Promise<FileRecord | null> {
  const { data, error } = await supabase
    .from('files')
    .select('*')
    .eq('line_message_id', lineMessageId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw error;
  const row = (data as FileRecord[] | null)?.[0];
  return row ?? null;
}

/**
 * Insert a file row. Idempotent by `line_message_id` (migration 022): if a
 * concurrent retry / webhook redelivery already inserted a live row for the same
 * LINE message, the unique partial index rejects this INSERT (23505) and we recover
 * the winner's row instead of throwing — returning `deduped: true` so the caller can
 * skip re-storing to R2 and re-charging quota. `deduped` is always false for
 * server-generated files (NULL line_message_id, e.g. merged scan PDFs).
 */
export async function createFileRecord(
  supabase: SupabaseClient,
  input: CreateFileInput,
): Promise<{ record: FileRecord; deduped: boolean }> {
  const { data, error } = await supabase
    .from('files')
    .insert({
      id: input.id,
      space_id: input.spaceId,
      uploaded_by: input.uploadedBy,
      original_name: input.originalName,
      mime_type: input.mimeType,
      file_size: input.fileSize,
      extension: input.extension,
      r2_key: input.r2Key,
      line_message_id: input.lineMessageId,
      line_source: input.lineSource,
      line_group_id: input.lineGroupId,
      scan_status: input.scanStatus ?? null,
      // Only sent when set — keeps inserts working if migration 005 isn't applied yet
      ...(input.teamId ? { team_id: input.teamId } : {}),
      // 'personal' is the column default (migration 015) — only 'team' is sent
      ...(input.chargedTo === 'team'
        ? { charged_to: 'team', charged_team_id: input.chargedTeamId ?? null }
        : {}),
      status: 'processing',
    })
    .select('*')
    .single();
  if (error) {
    // Lost the INSERT race on the unique line_message_id index (migration 022) —
    // recover the row the winning run just stored. Only treat 23505 as a dedup when
    // we can actually find that row by message id; otherwise it's a real error.
    if (error.code === PG_UNIQUE_VIOLATION && input.lineMessageId) {
      const existing = await findLiveFileByLineMessageId(supabase, input.lineMessageId);
      if (existing) return { record: existing, deduped: true };
    }
    throw error;
  }
  return { record: data as FileRecord, deduped: false };
}

export async function markFileReady(
  supabase: SupabaseClient,
  fileId: string,
  fileSize: number,
): Promise<void> {
  const { error } = await supabase
    .from('files')
    .update({ status: 'ready', file_size: fileSize, updated_at: new Date().toISOString() })
    .eq('id', fileId);
  if (error) throw error;
}

export async function markFileError(supabase: SupabaseClient, fileId: string): Promise<void> {
  const { error } = await supabase
    .from('files')
    .update({ status: 'error', updated_at: new Date().toISOString() })
    .eq('id', fileId);
  if (error) throw error;
}

/**
 * Adjust a user's storage counter by `delta` bytes (positive to add, negative to
 * free) atomically. Backed by the `increment_storage_used` Postgres function
 * (migration 003) — a single UPDATE, so concurrent uploads can't clobber each
 * other's writes. Clamps at 0 server-side.
 *
 * When `spaceId` is provided, the storage monitor runs after the adjustment
 * (80%/95% owner alerts, and re-arming when usage falls back under 70%).
 * The monitor never throws, so the quota update itself can't be failed by it.
 */
export async function adjustStorageUsed(
  supabase: SupabaseClient,
  userId: string,
  delta: number,
  spaceId?: string,
): Promise<void> {
  const { error } = await supabase.rpc('increment_storage_used', {
    p_user_id: userId,
    p_delta: delta,
  });
  if (error) throw error;
  if (spaceId) await checkStorageAlert(supabase, userId, spaceId);
}

export function addStorageUsed(
  supabase: SupabaseClient,
  userId: string,
  bytes: number,
  spaceId?: string,
): Promise<void> {
  return adjustStorageUsed(supabase, userId, bytes, spaceId);
}

export interface PersonalStorageResult {
  used: number;
  limit: number;
  overLimit: boolean;
}

/**
 * Atomic personal-quota adjustment via the `increment_personal_storage` RPC
 * (migration 014) — the per-user counterpart of `incrementTeamStorage`.
 *
 * enforce=true (default): the guarded UPDATE applies the increment ONLY if it
 * stays within storage_limit; otherwise nothing changes and `overLimit` is
 * true — use it to RESERVE quota BEFORE storing a file. enforce=false:
 * unconditional (clamped at 0) — use it to settle declared-vs-actual drift
 * after upload or to refund a failed/rejected file. Rule 8 applies: never
 * read-modify-write this counter.
 */
export async function incrementPersonalStorage(
  supabase: SupabaseClient,
  userId: string,
  bytes: number,
  opts: { enforce?: boolean } = {},
): Promise<PersonalStorageResult> {
  const { data, error } = await supabase.rpc('increment_personal_storage', {
    p_user_id: userId,
    p_delta: Math.round(bytes),
    p_enforce: opts.enforce ?? true,
  });
  if (error) throw error;
  // RETURNS TABLE → PostgREST hands back an array with one row
  const row = (Array.isArray(data) ? data[0] : data) as
    | { storage_used: number | null; storage_limit: number | null; over_limit: boolean }
    | undefined;
  if (!row) throw new Error(`increment_personal_storage returned no row for user ${userId}`);
  return {
    used: Number(row.storage_used ?? 0),
    limit: Number(row.storage_limit ?? 0),
    overLimit: Boolean(row.over_limit),
  };
}

export async function isSpaceMember(
  supabase: SupabaseClient,
  spaceId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('space_members')
    .select('user_id')
    .eq('space_id', spaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}
