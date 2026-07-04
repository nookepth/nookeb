import type { SupabaseClient } from '@supabase/supabase-js';
import type { ScanPageRecord, ScanSessionRecord } from '@nookeb/shared';
import { createR2Client, deleteObject } from './r2.service';

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours, matches the schema default

// Reused for best-effort cleanup of a removed page's scan-temp object (same
// client style as the worker; page cancellation is an infrequent user command).
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
): Promise<ScanSessionRecord> {
  await supabase
    .from('scan_sessions')
    .update({ status: 'cancelled' })
    .eq('user_id', userId)
    .eq('status', 'collecting');

  const { data, error } = await supabase
    .from('scan_sessions')
    .insert({
      user_id: userId,
      space_id: spaceId,
      status: 'collecting',
      page_count: 0,
      expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as ScanSessionRecord;
}

export async function cancelSession(supabase: SupabaseClient, sessionId: string): Promise<void> {
  const { error } = await supabase
    .from('scan_sessions')
    .update({ status: 'cancelled' })
    .eq('id', sessionId);
  if (error) throw error;
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
  pageNumber: number,
  r2Key: string,
  lineMessageId: string,
): Promise<void> {
  const { error } = await supabase.from('scan_pages').insert({
    session_id: sessionId,
    page_number: pageNumber,
    r2_key: r2Key,
    line_message_id: lineMessageId,
  });
  if (error) throw error;
}

/** All pages for a session, ordered by arrival time (stable page order). */
export async function listPages(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<ScanPageRecord[]> {
  const { data, error } = await supabase
    .from('scan_pages')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data as ScanPageRecord[]) ?? [];
}

/**
 * Remove the collected page at 0-based `idx` (arrival order — the same order
 * `finalize_scan` uses to build the PDF, so it matches the "รูปที่ N" the user
 * counts). Returns `total` (pages present BEFORE the delete, for index
 * validation / messaging) and `remaining` (after). `deleted` is false when the
 * index is out of range — nothing is touched. The page's scan-temp R2 object is
 * dropped best-effort, mirroring the finalize cleanup; a failed object delete
 * never fails the command (it just leaves an orphan for later session cleanup).
 */
export async function deletePageAt(
  supabase: SupabaseClient,
  sessionId: string,
  idx: number,
): Promise<{ deleted: boolean; total: number; remaining: number }> {
  // Explicit ASC-by-created_at ordering, kept LOCAL to this function rather than
  // relying on the shared listPages() default — index 0 = first image sent =
  // "รูปที่ 1". finalize_scan keeps its own (also-ASC) ordering, untouched.
  const { data, error: listErr } = await supabase
    .from('scan_pages')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (listErr) throw listErr;
  const pages = (data as ScanPageRecord[]) ?? [];
  const total = pages.length;
  if (idx < 0 || idx >= total) {
    return { deleted: false, total, remaining: total };
  }
  const page = pages[idx]!;
  console.log(
    `[deletePageAt] n=${idx + 1} idx=${idx} total=${pages.length} ` +
      `deleting page_id=${page.id} created_at=${page.created_at}`,
  );
  const { error } = await supabase.from('scan_pages').delete().eq('id', page.id);
  if (error) throw error;
  try {
    await deleteObject(r2, page.r2_key);
  } catch {
    // best-effort — an orphaned temp object must not fail the user's command
  }
  return { deleted: true, total, remaining: total - 1 };
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
