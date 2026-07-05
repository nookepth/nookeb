/**
 * One-time maintenance: set every user's storage_limit to the current
 * DEFAULT_STORAGE_LIMIT and recompute storage_used from the actual non-deleted
 * files they uploaded.
 *
 * ⚠️ Predates the referral tier system (migration 010): running it now would
 * overwrite tier-earned quotas with the 1 GB default for EVERYONE. For the
 * referral-era quota reset use scripts/backfill-referral-codes.ts instead,
 * which only touches unused accounts.
 */
import { createClient } from '@supabase/supabase-js';
import { config } from '../src/config';

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  const { data: users, error } = await supabase.from('users').select('id, display_name');
  if (error) throw error;

  for (const u of users ?? []) {
    const { data: files, error: fErr } = await supabase
      .from('files')
      .select('file_size')
      .eq('uploaded_by', u.id)
      .is('deleted_at', null);
    if (fErr) throw fErr;
    const used = (files ?? []).reduce((sum, f) => sum + (f.file_size as number), 0);

    const { error: upErr } = await supabase
      .from('users')
      .update({ storage_used: used, storage_limit: config.DEFAULT_STORAGE_LIMIT })
      .eq('id', u.id);
    if (upErr) throw upErr;
    console.log(`${u.display_name ?? u.id}: used=${used} bytes, limit=${config.DEFAULT_STORAGE_LIMIT}`);
  }
  console.log('backfill done');
}
main().catch((e) => { console.error(e); process.exit(1); });
