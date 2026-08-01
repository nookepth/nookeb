/**
 * หนูเก็บความทรงจำ — data access for the diary-reminder add-on (migration 052).
 *
 * An ADD-ON, not a plan: `diary_addon_subscriptions` is completely independent
 * of `subscriptions` and of `users.plan`, so a free user can hold it and a
 * premium user buying it never has their plan row touched. Nothing in this file
 * reads or writes a plan.
 *
 * NO PAYMENT PROVIDER EXISTS. `createSubscription` records an ACTIVE row without
 * taking a satang — it is the seam a payment callback will call once one exists,
 * which is why the route that reaches it is not exposed to users yet (see
 * routes/diaryAddon.ts).
 *
 * Every function is service-role Supabase, same as the other services here; the
 * caller has already authenticated and the userId is always the session's.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { diaryAddonPrice, type BillingCycle } from '../config/plans';

const PG_UNIQUE_VIOLATION = '23505';

/** Bangkok is UTC+7 with no DST, so a fixed offset is exact. */
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

export type DiaryAddonStatus = 'active' | 'cancelled' | 'expired';
export type DiaryAddonSkipReason = 'already_wrote' | 'expired' | 'cancelled';

export interface DiaryAddonSubscriptionRecord {
  id: string;
  user_id: string;
  status: DiaryAddonStatus;
  billing_cycle: BillingCycle;
  price_thb: number;
  started_at: string;
  expires_at: string;
  cancelled_at: string | null;
  /** 'HH:MM:SS' as Postgres returns a TIME. */
  notify_time: string;
  created_at: string;
}

/** Bangkok calendar day ('YYYY-MM-DD') for an instant. */
export function bangkokDate(at: Date = new Date()): string {
  return new Date(at.getTime() + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

/** Bangkok hour (0–23) for an instant — what the hourly sweep matches on. */
export function bangkokHour(at: Date = new Date()): number {
  return new Date(at.getTime() + BANGKOK_OFFSET_MS).getUTCHours();
}

/** 'HH:MM', 00:00–23:59. Anything else is rejected at the route. */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidNotifyTime(value: string): boolean {
  return HHMM.test(value);
}

/** 'HH:MM:SS' (or 'HH:MM') → 'HH:MM'. Postgres TIME always returns seconds. */
export function toHhMm(time: string): string {
  return time.slice(0, 5);
}

/**
 * The user's row, whatever its status. Returns null when they never bought.
 *
 * Reads the row rather than a boolean because every caller wants both — the
 * routes render the cycle and expiry, and the sweep needs notify_time.
 */
export async function getSubscription(
  supabase: SupabaseClient,
  userId: string,
): Promise<DiaryAddonSubscriptionRecord | null> {
  const { data, error } = await supabase
    .from('diary_addon_subscriptions')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as DiaryAddonSubscriptionRecord | null) ?? null;
}

/**
 * True when the row is live RIGHT NOW: status 'active' AND not yet past
 * expires_at.
 *
 * BOTH halves are required. A 'cancelled' row keeps its access until expiry
 * (cancel = "do not renew"), and an 'active' row whose expiry has passed is a
 * lapsed subscription that no expiry job has swept yet. Checking one alone
 * either cuts a paying user off early or keeps pushing to a lapsed one.
 */
export function isSubscriptionLive(
  row: DiaryAddonSubscriptionRecord | null,
  now: Date = new Date(),
): boolean {
  if (!row) return false;
  if (row.status !== 'active') return false;
  return new Date(row.expires_at).getTime() > now.getTime();
}

export interface AddonStatusResult {
  active: boolean;
  subscription: DiaryAddonSubscriptionRecord | null;
}

export async function getAddonStatus(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date(),
): Promise<AddonStatusResult> {
  const subscription = await getSubscription(supabase, userId);
  return { active: isSubscriptionLive(subscription, now), subscription };
}

/** expires_at for a cycle: +1 calendar month or +1 calendar year from `from`. */
export function computeExpiry(cycle: BillingCycle, from: Date = new Date()): Date {
  const d = new Date(from.getTime());
  // setUTCMonth/​setUTCFullYear clamp naturally in JS: 31 Jan + 1 month lands on
  // 3 Mar, which is WRONG for billing, so the day is clamped explicitly to the
  // target month's length. 31 Jan + 1 month = 28/29 Feb, matching how Postgres
  // `NOW() + INTERVAL '1 month'` behaves — the two must not disagree.
  const day = d.getUTCDate();
  if (cycle === 'monthly') {
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
  } else {
    d.setUTCDate(1);
    d.setUTCFullYear(d.getUTCFullYear() + 1);
  }
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/**
 * Buy (or re-buy) the add-on.
 *
 * UPSERT on user_id, because migration 052 holds ONE row per user for all time
 * (uq_diary_addon_user). A resubscribe after cancelling therefore revives the
 * same row: status back to 'active', a fresh started_at/expires_at, cancelled_at
 * cleared. notify_time is deliberately NOT reset — a returning user keeps the
 * time they chose.
 *
 * TODO(payment): this must be called by a payment-provider callback, never
 * directly by a user request. It grants paid access for free as written.
 */
export async function createSubscription(
  supabase: SupabaseClient,
  userId: string,
  billingCycle: BillingCycle,
  now: Date = new Date(),
): Promise<DiaryAddonSubscriptionRecord> {
  const { data, error } = await supabase
    .from('diary_addon_subscriptions')
    .upsert(
      {
        user_id: userId,
        status: 'active',
        billing_cycle: billingCycle,
        // TODO(payment): the price CHARGED must come from the payment callback,
        // not from config — if the two ever disagree, the receipt wins.
        price_thb: diaryAddonPrice(billingCycle),
        started_at: now.toISOString(),
        expires_at: computeExpiry(billingCycle, now).toISOString(),
        cancelled_at: null,
      },
      { onConflict: 'user_id' },
    )
    .select('*')
    .single();
  if (error) throw error;
  return data as DiaryAddonSubscriptionRecord;
}

/**
 * Cancel. Never deletes: the row keeps sending until expires_at, and the
 * history of what was bought stays readable.
 *
 * Gated on status = 'active' so a second cancel cannot overwrite the original
 * cancelled_at with a later timestamp. Returns null when there was nothing live
 * to cancel, which the route turns into a 404.
 */
export async function cancelSubscription(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date(),
): Promise<DiaryAddonSubscriptionRecord | null> {
  const { data, error } = await supabase
    .from('diary_addon_subscriptions')
    .update({ status: 'cancelled', cancelled_at: now.toISOString() })
    .eq('user_id', userId)
    .eq('status', 'active')
    .select('*');
  if (error) throw error;
  return (data as DiaryAddonSubscriptionRecord[] | null)?.[0] ?? null;
}

/** Convenience wrapper — one round trip, the sweep's per-user re-check. */
export async function isActiveSubscriber(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  return isSubscriptionLive(await getSubscription(supabase, userId), now);
}

/**
 * The user's chosen reminder time as 'HH:MM' (Bangkok), or null when they hold
 * no subscription at all. A subscriber who never touched the setting gets the
 * column default, 20:00.
 */
export async function getNotifyTime(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const row = await getSubscription(supabase, userId);
  return row ? toHhMm(row.notify_time) : null;
}

export class InvalidNotifyTimeError extends Error {
  constructor() {
    super('notifyTime must be HH:MM between 00:00 and 23:59');
    this.name = 'InvalidNotifyTimeError';
  }
}

/**
 * Update the reminder time. Validates 'HH:MM' HERE as well as at the route —
 * this value is written into a Postgres TIME and read back by the sweep, and a
 * malformed one would either fail the UPDATE or silently shift a user's nudge.
 *
 * Returns null when the user holds no subscription (nothing to update).
 */
export async function setNotifyTime(
  supabase: SupabaseClient,
  userId: string,
  time: string,
): Promise<string | null> {
  if (!isValidNotifyTime(time)) throw new InvalidNotifyTimeError();
  const { data, error } = await supabase
    .from('diary_addon_subscriptions')
    .update({ notify_time: `${time}:00` })
    .eq('user_id', userId)
    .select('notify_time');
  if (error) throw error;
  const row = (data as { notify_time: string }[] | null)?.[0];
  return row ? toHhMm(row.notify_time) : null;
}

/**
 * Record a delivered nudge.
 *
 * The UNIQUE(user_id, date) violation is swallowed and reported as
 * `deduped: true` rather than thrown: this log row IS the sweep's
 * once-per-Bangkok-day guard, so a retried job hitting an existing row is the
 * constraint doing its job, not an error.
 */
export async function logSent(
  supabase: SupabaseClient,
  userId: string,
  date: string,
  now: Date = new Date(),
): Promise<{ deduped: boolean }> {
  return insertLog(supabase, {
    userId,
    date,
    skipped: false,
    skipReason: null,
    sentAt: now,
  });
}

/** Record a nudge we deliberately did not send, and why. Same dedup rule. */
export async function logSkipped(
  supabase: SupabaseClient,
  userId: string,
  date: string,
  reason: DiaryAddonSkipReason,
  now: Date = new Date(),
): Promise<{ deduped: boolean }> {
  return insertLog(supabase, {
    userId,
    date,
    skipped: true,
    skipReason: reason,
    sentAt: now,
  });
}

async function insertLog(
  supabase: SupabaseClient,
  input: {
    userId: string;
    date: string;
    skipped: boolean;
    skipReason: DiaryAddonSkipReason | null;
    sentAt: Date;
  },
): Promise<{ deduped: boolean }> {
  const { error } = await supabase.from('diary_addon_logs').insert({
    user_id: input.userId,
    date: input.date,
    skipped: input.skipped,
    skip_reason: input.skipReason,
    sent_at: input.sentAt.toISOString(),
  });
  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) return { deduped: true };
    throw error;
  }
  return { deduped: false };
}

/**
 * Has this user already written today's diary entry?
 *
 * Reads `diary_entries` (migration 028) by its Bangkok calendar column
 * `entry_date` — NOT by created_at. The two differ: an entry can be created
 * just after midnight ICT for a day the user is still finishing, and
 * `entry_date` is the column the one-entry-per-day unique index is built on, so
 * it is the only definition of "today" the rest of the diary feature uses.
 *
 * Soft-deleted rows are excluded (rule 6) — a user who deleted today's entry
 * has, for reminder purposes, not written today.
 */
export async function alreadyWrittenToday(
  supabase: SupabaseClient,
  userId: string,
  bangkokDateStr: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('diary_entries')
    .select('id')
    .eq('user_id', userId)
    .eq('entry_date', bangkokDateStr)
    .is('deleted_at', null)
    .limit(1);
  if (error) throw error;
  return ((data as { id: string }[] | null) ?? []).length > 0;
}

/**
 * Everyone due a nudge in `hour` (Bangkok, 0–23): live subscriptions whose
 * notify_time falls anywhere inside that hour, e.g. 20:00–20:59 for hour 20.
 *
 * The hour window is applied as a string range on the TIME column rather than
 * fetched-and-filtered, so a sweep never pulls the whole subscriber table.
 * `expires_at > now` is applied here too, but the per-user re-check in the
 * sweep still runs: a subscription can lapse between the query and the push.
 */
export async function listDueSubscribers(
  supabase: SupabaseClient,
  hour: number,
  now: Date = new Date(),
  limit = 5000,
): Promise<DiaryAddonSubscriptionRecord[]> {
  const hh = String(hour).padStart(2, '0');
  const { data, error } = await supabase
    .from('diary_addon_subscriptions')
    .select('*')
    .eq('status', 'active')
    .gt('expires_at', now.toISOString())
    .gte('notify_time', `${hh}:00:00`)
    .lte('notify_time', `${hh}:59:59`)
    .limit(limit);
  if (error) throw error;
  return (data as DiaryAddonSubscriptionRecord[] | null) ?? [];
}
