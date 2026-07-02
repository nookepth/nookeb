/**
 * Purge R2 objects of files soft-deleted past the retention window.
 * The DB rows are kept as tombstones (project rule: never hard-delete files rows).
 *
 * Dry-run by default — shows what WOULD be deleted:
 *   npx tsx --env-file=../../.env scripts/purge-deleted.ts
 * Actually delete:
 *   npx tsx --env-file=../../.env scripts/purge-deleted.ts --apply
 * Override retention (days):
 *   npx tsx --env-file=../../.env scripts/purge-deleted.ts --days 7 --apply
 *
 * The worker also runs this automatically once a day; this script is for manual/ad-hoc runs.
 */
import { createClient } from '@supabase/supabase-js';
import { config } from '../src/config';
import { createR2Client } from '../src/services/r2.service';
import { purgeDeletedFiles } from '../src/services/purge.service';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const days = Number(argValue('--days') ?? config.PURGE_RETENTION_DAYS);

  const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const r2 = createR2Client();

  console.log(`${apply ? 'APPLY' : 'DRY-RUN'} — purging files soft-deleted more than ${days} day(s) ago`);
  const result = await purgeDeletedFiles(supabase, r2, { retentionDays: days, apply });

  console.log(`cutoff:          ${result.cutoff}`);
  console.log(`files matched:   ${result.scanned}`);
  console.log(`objects ${apply ? 'deleted' : 'to delete'}: ${result.objectsDeleted}`);
  if (apply) console.log(`errors:          ${result.errors}`);
  if (result.purgedFileIds.length > 0) {
    console.log(`file ids: ${result.purgedFileIds.slice(0, 20).join(', ')}${result.purgedFileIds.length > 20 ? ' ...' : ''}`);
  }
  console.log(apply ? 'done ✓' : 'dry-run complete (pass --apply to delete)');
}
main().catch((e) => { console.error(e); process.exit(1); });
