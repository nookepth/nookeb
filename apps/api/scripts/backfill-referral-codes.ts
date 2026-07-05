/**
 * One-time referral-system backfill (safe to re-run):
 *  1. Assign a referral_code to every user that doesn't have one yet.
 *  2. Reset storage_limit to the current default (1 GB) for OLD UNUSED accounts
 *     that still carry the pre-referral 10 GB default — only rows with
 *     storage_used = 0, no referred_by_id, and no referrals made
 *     (referral_count = 0, so tier-earned quotas are never reduced).
 *     Users with any stored bytes are NEVER touched.
 *
 * With --reset-all it instead performs the migration-012 clean slate: EVERY
 * user (admins included, regardless of storage_used) goes back to the 1 GB
 * default, referral_count = 0, referred_by_id = NULL, and all referrals rows
 * are deleted. referral_code is kept. Combine with --dry-run to preview.
 *
 * Usage:
 *   npx tsx --env-file=../../.env scripts/backfill-referral-codes.ts --dry-run
 *   npx tsx --env-file=../../.env scripts/backfill-referral-codes.ts
 *   npx tsx --env-file=../../.env scripts/backfill-referral-codes.ts --reset-all [--dry-run]
 */
import { createClient } from '@supabase/supabase-js';
import { config } from '../src/config';
import { generateReferralCode } from '../src/services/referral.service';

const dryRun = process.argv.includes('--dry-run');
const resetAll = process.argv.includes('--reset-all');

const ONE_GB = 1073741824;

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** --reset-all: same effect as supabase/migrations/012_reset_quota.sql. */
async function resetAllUsers() {
  const { data: affected, error: listErr } = await supabase
    .from('users')
    .select('id, display_name, storage_limit, referral_count, referred_by_id');
  if (listErr) throw listErr;

  const { count: referralRows, error: cntErr } = await supabase
    .from('referrals')
    .select('id', { count: 'exact', head: true });
  if (cntErr) throw cntErr;

  for (const u of affected ?? []) {
    console.log(
      `${dryRun ? 'would reset' : 'resetting'} ${u.display_name ?? u.id}: ` +
        `limit ${u.storage_limit} → ${ONE_GB}, count ${u.referral_count} → 0`,
    );
  }
  console.log(`${dryRun ? 'would delete' : 'deleting'} ${referralRows ?? 0} referrals rows`);
  if (dryRun) return;

  const { error: upErr } = await supabase
    .from('users')
    .update({
      storage_limit: ONE_GB,
      referral_count: 0,
      referred_by_id: null,
      updated_at: new Date().toISOString(),
    })
    .not('id', 'is', null); // PostgREST requires a filter — match every row
  if (upErr) throw upErr;

  const { error: delErr } = await supabase.from('referrals').delete().not('id', 'is', null);
  if (delErr) throw delErr;

  console.log(`\n✅ reset ${affected?.length ?? 0} users to 1 GB, cleared referrals`);
}

async function main() {
  if (dryRun) console.log('DRY RUN — nothing will be written\n');

  if (resetAll) {
    await resetAllUsers();
    return;
  }

  // 1. users without a referral code
  const { data: noCode, error: codeErr } = await supabase
    .from('users')
    .select('id, display_name')
    .is('referral_code', null);
  if (codeErr) throw codeErr;

  let backfilled = 0;
  for (const u of noCode ?? []) {
    if (dryRun) {
      console.log(`would assign code: ${u.display_name ?? u.id}`);
      backfilled++;
      continue;
    }
    const code = await generateReferralCode(supabase, u.id);
    console.log(`assigned ${code}: ${u.display_name ?? u.id}`);
    backfilled++;
  }

  // 2. old unused accounts still on the pre-referral default quota.
  //    Guards: no stored bytes, never redeemed a code, never referred anyone —
  //    so nobody loses earned or purchased-in-future space.
  const { data: oldQuota, error: quotaErr } = await supabase
    .from('users')
    .select('id, display_name, storage_limit')
    .gt('storage_limit', config.DEFAULT_STORAGE_LIMIT)
    .eq('storage_used', 0)
    .is('referred_by_id', null)
    .eq('referral_count', 0);
  if (quotaErr) throw quotaErr;

  let reset = 0;
  for (const u of oldQuota ?? []) {
    if (dryRun) {
      console.log(`would reset quota ${u.storage_limit} → ${config.DEFAULT_STORAGE_LIMIT}: ${u.display_name ?? u.id}`);
      reset++;
      continue;
    }
    const { error: upErr } = await supabase
      .from('users')
      .update({ storage_limit: config.DEFAULT_STORAGE_LIMIT, updated_at: new Date().toISOString() })
      .eq('id', u.id)
      // re-assert the guards in the UPDATE itself in case usage changed mid-run
      .eq('storage_used', 0)
      .is('referred_by_id', null)
      .eq('referral_count', 0);
    if (upErr) throw upErr;
    console.log(`reset quota → ${config.DEFAULT_STORAGE_LIMIT}: ${u.display_name ?? u.id}`);
    reset++;
  }

  console.log(`\n✅ backfilled ${backfilled} codes, reset ${reset} unused quotas${dryRun ? ' (dry run)' : ''}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
