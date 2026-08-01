/**
 * Priority support (§18).
 *
 * The SLA is DERIVED from the plan at ticket-creation time and then STORED on
 * the row. Both halves matter:
 *
 *  - derived, because the spec forbids hard-coding it at the route — the number
 *    lives in config/plans.ts and nowhere else;
 *  - stored, because the promise made when the ticket was opened must survive
 *    the user changing plan afterwards. A premium user who downgrades on
 *    Tuesday still gets the 4-hour answer they were owed on Monday.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { hasFeature, slaHoursFor, type Plan } from '../config/plans';

export interface SupportTicket {
  id: string;
  user_id: string;
  subject: string;
  body: string;
  plan_at_creation: Plan;
  sla_hours: number;
  due_at: string;
  onboarding_call: boolean;
  status: 'open' | 'answered' | 'closed';
  first_response_at: string | null;
  created_at: string;
}

export interface CreateTicketInput {
  userId: string;
  plan: Plan;
  subject: string;
  body: string;
  /** Premium only — silently false on other plans rather than rejected. */
  requestOnboardingCall?: boolean;
  now?: Date;
}

export async function createTicket(
  supabase: SupabaseClient,
  input: CreateTicketInput,
): Promise<SupportTicket> {
  const now = input.now ?? new Date();
  const slaHours = slaHoursFor(input.plan);
  const dueAt = new Date(now.getTime() + slaHours * 60 * 60 * 1000);

  // Asking for the onboarding call on a plan that doesn't include it is not an
  // error — the ticket is still valid support. The flag simply stays false, and
  // the reply can offer an upgrade.
  const onboardingCall =
    Boolean(input.requestOnboardingCall) && hasFeature(input.plan, 'onboarding_call');

  const { data, error } = await supabase
    .from('support_tickets')
    .insert({
      user_id: input.userId,
      subject: input.subject,
      body: input.body,
      plan_at_creation: input.plan,
      sla_hours: slaHours,
      due_at: dueAt.toISOString(),
      onboarding_call: onboardingCall,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as SupportTicket;
}

export async function listTickets(
  supabase: SupabaseClient,
  userId: string,
): Promise<SupportTicket[]> {
  const { data, error } = await supabase
    .from('support_tickets')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as SupportTicket[];
}

export async function getTicket(
  supabase: SupabaseClient,
  userId: string,
  ticketId: string,
): Promise<SupportTicket | null> {
  const { data, error } = await supabase
    .from('support_tickets')
    .select('*')
    .eq('id', ticketId)
    .eq('user_id', userId) // tenant guard: never read another user's ticket
    .maybeSingle();
  if (error) throw error;
  return (data as SupportTicket | null) ?? null;
}

/**
 * Stamp the first response. Only the FIRST one counts against the SLA, so this
 * refuses to overwrite an existing stamp — a second reply must not reset the
 * clock and make a breached ticket look compliant.
 */
export async function markResponded(
  supabase: SupabaseClient,
  ticketId: string,
  now: Date = new Date(),
): Promise<void> {
  const { error } = await supabase
    .from('support_tickets')
    .update({ first_response_at: now.toISOString(), status: 'answered', updated_at: now.toISOString() })
    .eq('id', ticketId)
    .is('first_response_at', null);
  if (error) throw error;
}

/** Open tickets past their SLA — the ops queue, worst breach first. */
export async function listBreachedTickets(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<SupportTicket[]> {
  const { data, error } = await supabase
    .from('support_tickets')
    .select('*')
    .eq('status', 'open')
    .lt('due_at', now.toISOString())
    .order('due_at', { ascending: true })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as SupportTicket[];
}
