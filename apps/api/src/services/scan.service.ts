import type { SupabaseClient } from '@supabase/supabase-js';
import type { ScanMode, ScanPageRecord, ScanSessionRecord, SessionKind } from '@nookeb/shared';
import { createR2Client, deleteObject } from './r2.service';

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours, matches the schema default

// Module-level client for temp-page cleanup — constructing an S3Client opens no
// connection, so this is cheap even in the API process (mirrors the worker).
const r2 = createR2Client();

/** The user's active (still-collecting, unexpired) scan session, if any. */
export async function getActiveSession(
  supabase: SupabaseClient,
  userId: string,
): Promise<ScanSessionRecord | null> {
  const { data, error } = await supabase
    .from('scan_sessions')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'collecting')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as ScanSessionRecord | null) ?? null;
}

/** Start a new session, cancelling any previous collecting one for the user. */
export async function startSession(
  supabase: SupabaseClient,
  userId: string,
  spaceId: string,
  scanMode?: ScanMode,
  kind: SessionKind = 'merge',
): Promise<ScanSessionRecord> {
  const { data: superseded, error: cancelError } = await supabase
    .from('scan_sessions')
    .update({ status: 'cancelled' })
    .eq('user_id', userId)
    .eq('status', 'collecting')
    .select('id');
  // Don't throw — getActiveSession picks the newest 'collecting' row, so a failed
  // cancel self-heals. But surface it: silence would hide two coexisting sessions.
  if (cancelError) {
    console.warn(
      `[scan] failed to cancel prior collecting session(s) for user ${userId}: ${cancelError.message}`,
    );
  }
  // Free the temp page images of any session we just superseded (best-effort;
  // the daily purge sweep is the safety net if this misses).
  for (const s of (superseded ?? []) as { id: string }[]) {
    await deleteScanTempObjects(supabase, s.id);
  }

  const { data, error } = await supabase
    .from('scan_sessions')
    .insert({
      user_id: userId,
      space_id: spaceId,
      status: 'collecting',
      page_count: 0,
      // Omitted when not given so the DB default ('bw', migration 019) applies
      ...(scanMode ? { scan_mode: scanMode } : {}),
      session_kind: kind, // 'scan' (สแกน) vs 'merge' (รวมรูป) — migration 020
      expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as ScanSessionRecord;
}

/** Switch the color mode of an in-flight session ("สแกนสี" / "สแกนขาวดำ"). */
export async function setSessionMode(
  supabase: SupabaseClient,
  sessionId: string,
  scanMode: ScanMode,
): Promise<void> {
  const { error } = await supabase
    .from('scan_sessions')
    .update({ scan_mode: scanMode })
    .eq('id', sessionId);
  if (error) throw error;
}

export async function cancelSession(supabase: SupabaseClient, sessionId: string): Promise<void> {
  const { error } = await supabase
    .from('scan_sessions')
    .update({ status: 'cancelled' })
    .eq('id', sessionId);
  if (error) throw error;
  // Free the temp page images now that the session is cancelled. Best-effort —
  // deleteScanTempObjects never throws, so a failed R2 delete can't block the
  // cancel; the daily purge sweep is the safety net.
  await deleteScanTempObjects(supabase, sessionId);
}

/**
 * Delete the R2 objects backing a session's scan pages (stored under
 * `spaces/{sid}/scan-temp/...`), then drop the scan_pages rows. Without this,
 * cancelled/timed-out sessions leak their page images forever — only a
 * successful finalize used to clean them up.
 *
 * Best-effort on R2: a failed object delete is caught + logged, never thrown, so
 * it can't block a session cancellation. Only rows whose object was actually
 * removed are dropped — the rest are kept so the daily purge sweep retries them.
 * A session with zero pages is handled gracefully (no-op).
 *
 * ONLY call this for sessions already out of 'collecting'/'processing' (i.e.
 * cancelled or done) — deleting temp pages under an in-flight session would
 * corrupt it. The r2_key on each row is self-contained (it encodes the space id),
 * so no spaceId argument is needed to locate the objects.
 */
export async function deleteScanTempObjects(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<{ objectsDeleted: number; errors: number }> {
  const pages = await listPages(supabase, sessionId);
  let objectsDeleted = 0;
  let errors = 0;
  const deletedIds: string[] = [];
  for (const page of pages) {
    try {
      await deleteObject(r2, page.r2_key);
      objectsDeleted += 1;
      deletedIds.push(page.id);
    } catch (err) {
      errors += 1;
      console.error(`[scan] scan-temp cleanup failed for ${page.r2_key}:`, err);
    }
  }
  if (deletedIds.length > 0) {
    const { error } = await supabase.from('scan_pages').delete().in('id', deletedIds);
    if (error) console.error(`[scan] scan-temp row delete failed (session=${sessionId}):`, error);
  }
  return { objectsDeleted, errors };
}

export async function setSessionStatus(
  supabase: SupabaseClient,
  sessionId: string,
  status: ScanSessionRecord['status'],
): Promise<void> {
  const { error } = await supabase
    .from('scan_sessions')
    .update({ status })
    .eq('id', sessionId);
  if (error) throw error;
}

export async function getSession(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<ScanSessionRecord | null> {
  const { data, error } = await supabase
    .from('scan_sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle();
  if (error) throw error;
  return (data as ScanSessionRecord | null) ?? null;
}

/**
 * Atomically bump the session's `expected_pages` counter by one (migration 023).
 * Called once per accepted image event in the webhook; finalize_scan compares this
 * against the stored page count so in-flight add_scan_page jobs aren't dropped.
 * Fails open: a missing column/RPC (migration not applied) is swallowed by the
 * caller so scanning still works — the wait-gate just no-ops.
 */
export async function incrementExpectedPages(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<void> {
  const { error } = await supabase.rpc('increment_expected_pages', { p_session_id: sessionId });
  if (error) throw error;
}

/** How many pages already collected — used for the "หน้า N" reply. */
export async function countPages(supabase: SupabaseClient, sessionId: string): Promise<number> {
  const { count, error } = await supabase
    .from('scan_pages')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId);
  if (error) throw error;
  return count ?? 0;
}

/** Has this LINE message already been stored as a page? Guards job retries. */
export async function pageExists(
  supabase: SupabaseClient,
  sessionId: string,
  lineMessageId: string,
): Promise<boolean> {
  const { count, error } = await supabase
    .from('scan_pages')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .eq('line_message_id', lineMessageId);
  if (error) throw error;
  return (count ?? 0) > 0;
}

export async function insertPage(
  supabase: SupabaseClient,
  sessionId: string,
  r2Key: string,
  lineMessageId: string,
): Promise<void> {
  // page ordinal is assigned atomically by the DB (page_seq, migration 018) —
  // do NOT compute it in app code (COUNT(*)+1 races under worker concurrency).
  const { error } = await supabase.from('scan_pages').insert({
    session_id: sessionId,
    r2_key: r2Key,
    line_message_id: lineMessageId,
  });
  if (error) throw error;
}

/** All pages for a session, ordered by the atomic insert sequence (stable). */
export async function listPages(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<ScanPageRecord[]> {
  const { data, error } = await supabase
    .from('scan_pages')
    .select('*')
    .eq('session_id', sessionId)
    .order('page_seq', { ascending: true });
  if (error) throw error;
  return (data as ScanPageRecord[]) ?? [];
}

/**
 * Record the produced PDF's file id on the session BEFORE the finalize job's
 * retry boundary (the status flip in finishSession). If finishSession later
 * fails and BullMQ retries, this marker lets the handler recognise the file was
 * already stored + charged and skip straight to completing the status flip.
 */
export async function setSessionResultFile(
  supabase: SupabaseClient,
  sessionId: string,
  resultFileId: string,
): Promise<void> {
  const { error } = await supabase
    .from('scan_sessions')
    .update({ result_file_id: resultFileId })
    .eq('id', sessionId);
  if (error) throw error;
}

export async function finishSession(
  supabase: SupabaseClient,
  sessionId: string,
  resultFileId: string,
  pageCount: number,
): Promise<void> {
  const { error } = await supabase
    .from('scan_sessions')
    .update({ status: 'done', result_file_id: resultFileId, page_count: pageCount })
    .eq('id', sessionId);
  if (error) throw error;
}
