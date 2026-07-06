import type { SupabaseClient } from '@supabase/supabase-js';
import type { ScanMode, ScanPageRecord, ScanSessionRecord } from '@nookeb/shared';

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours, matches the schema default

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
      // Omitted when not given so the DB default ('bw', migration 019) applies
      ...(scanMode ? { scan_mode: scanMode } : {}),
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
