/**
 * /support — priority support tickets (§18).
 *
 * Available on EVERY plan; the plan only decides the SLA and whether the
 * onboarding call is included. There is deliberately no planGuard here: gating
 * the ability to report a problem behind a paid tier would be a support policy
 * nobody asked for.
 *
 * DISABLED — every route below answers 503 SUPPORT_NOT_READY unconditionally.
 * There is no UI surface anywhere in the product: no user can file a ticket and,
 * more importantly, NO ADMIN CAN READ ONE. Ticket rows carry an SLA clock
 * (sla_hours + due_at) that would run — and be missed — on rows nobody monitors,
 * which is worse than having no ticket system at all. The original handler
 * bodies are commented out in place; restore them when the admin ticket UI ships.
 * See "Temporarily Disabled Endpoints" in CLAUDE.md.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { hasFeature, slaHoursFor } from '../config/plans';
import { createTicket, getTicket, listTickets } from '../services/support.service';
import { ensurePlan } from '../middleware/planGuard';

const createTicketSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
  requestOnboardingCall: z.boolean().optional(),
});

/** The single 503 body every disabled support route returns. */
const NOT_IMPLEMENTED = {
  error: 'NOT_IMPLEMENTED',
  message: 'Support system is not yet available.',
  code: 'SUPPORT_NOT_READY',
} as const;

const supportRoutes: FastifyPluginAsync = async (app) => {
  // ---- GET /support/sla — what this user is entitled to -------------------
  // Lets the UI show "we'll reply within 4 hours" BEFORE the ticket is written.
  //
  // DISABLED — no admin panel exists to read these tickets.
  // SLA clock must not run on unmonitored rows.
  // Re-enable when admin ticket UI is built.
  app.get('/support/sla', { preHandler: app.authenticate }, async (request, reply) => {
    void request; // handler disabled below — the request is never read
    return reply.code(503).send(NOT_IMPLEMENTED);
    // --- ORIGINAL HANDLER (restore when the admin ticket UI exists) ---------
    // const plan = await ensurePlan(request);
    // return {
    //   plan,
    //   slaHours: slaHoursFor(plan),
    //   onboardingCall: hasFeature(plan, 'onboarding_call'),
    // };
  });

  // ---- POST /support/tickets ---------------------------------------------
  // Tight per-IP cap: a ticket is a human action, and each one enters an ops
  // queue with a clock attached.
  //
  // DISABLED — no admin panel exists to read these tickets.
  // SLA clock must not run on unmonitored rows.
  // Re-enable when admin ticket UI is built.
  app.post('/support/tickets', {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    void request; // handler disabled below — the body is never read
    return reply.code(503).send(NOT_IMPLEMENTED);
    // --- ORIGINAL HANDLER (restore when the admin ticket UI exists) ---------
    // const parsed = createTicketSchema.safeParse(request.body);
    // if (!parsed.success) {
    //   return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    // }
    // const plan = await ensurePlan(request);
    //
    // const ticket = await createTicket(app.supabase, {
    //   userId: request.authUser!.userId,
    //   plan,
    //   subject: parsed.data.subject,
    //   body: parsed.data.body,
    //   requestOnboardingCall: parsed.data.requestOnboardingCall,
    // });
    //
    // return reply.code(201).send({
    //   ticket: {
    //     id: ticket.id,
    //     subject: ticket.subject,
    //     status: ticket.status,
    //     slaHours: ticket.sla_hours,
    //     dueAt: ticket.due_at,
    //     onboardingCall: ticket.onboarding_call,
    //     createdAt: ticket.created_at,
    //   },
    // });
  });

  // ---- GET /support/tickets ----------------------------------------------
  //
  // DISABLED — no admin panel exists to read these tickets.
  // SLA clock must not run on unmonitored rows.
  // Re-enable when admin ticket UI is built.
  app.get('/support/tickets', { preHandler: app.authenticate }, async (request, reply) => {
    void request; // handler disabled below — the request is never read
    return reply.code(503).send(NOT_IMPLEMENTED);
    // --- ORIGINAL HANDLER (restore when the admin ticket UI exists) ---------
    // const tickets = await listTickets(app.supabase, request.authUser!.userId);
    // return {
    //   tickets: tickets.map((t) => ({
    //     id: t.id,
    //     subject: t.subject,
    //     status: t.status,
    //     slaHours: t.sla_hours,
    //     dueAt: t.due_at,
    //     firstResponseAt: t.first_response_at,
    //     onboardingCall: t.onboarding_call,
    //     createdAt: t.created_at,
    //   })),
    // };
  });

  // ---- GET /support/tickets/:id ------------------------------------------
  //
  // DISABLED — no admin panel exists to read these tickets.
  // SLA clock must not run on unmonitored rows.
  // Re-enable when admin ticket UI is built.
  app.get<{ Params: { id: string } }>(
    '/support/tickets/:id',
    { preHandler: app.authenticate },
    async (request, reply) => {
      void request; // handler disabled below — the params are never read
      return reply.code(503).send(NOT_IMPLEMENTED);
      // --- ORIGINAL HANDLER (restore when the admin ticket UI exists) -------
      // if (!z.string().uuid().safeParse(request.params.id).success) {
      //   return reply.code(400).send({ error: 'Invalid ticket id' });
      // }
      // const ticket = await getTicket(app.supabase, request.authUser!.userId, request.params.id);
      // if (!ticket) return reply.code(404).send({ error: 'ไม่พบตั๋วนี้น้า' });
      // return reply.send({ ticket });
    },
  );
};

export default supportRoutes;

// The imports below are retained deliberately: they are exactly what the
// commented-out handlers above need when support is re-enabled. Referenced here
// so a linter cannot flag them as unused and "helpfully" delete the seam.
void createTicketSchema;
void hasFeature;
void slaHoursFor;
void createTicket;
void getTicket;
void listTickets;
void ensurePlan;
