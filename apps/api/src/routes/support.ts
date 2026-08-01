/**
 * /support — priority support tickets (§18).
 *
 * Available on EVERY plan; the plan only decides the SLA and whether the
 * onboarding call is included. There is deliberately no planGuard here: gating
 * the ability to report a problem behind a paid tier would be a support policy
 * nobody asked for.
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

const supportRoutes: FastifyPluginAsync = async (app) => {
  // ---- GET /support/sla — what this user is entitled to -------------------
  // Lets the UI show "we'll reply within 4 hours" BEFORE the ticket is written.
  app.get('/support/sla', { preHandler: app.authenticate }, async (request) => {
    const plan = await ensurePlan(request);
    return {
      plan,
      slaHours: slaHoursFor(plan),
      onboardingCall: hasFeature(plan, 'onboarding_call'),
    };
  });

  // ---- POST /support/tickets ---------------------------------------------
  // Tight per-IP cap: a ticket is a human action, and each one enters an ops
  // queue with a clock attached.
  app.post('/support/tickets', {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const parsed = createTicketSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }
    const plan = await ensurePlan(request);

    const ticket = await createTicket(app.supabase, {
      userId: request.authUser!.userId,
      plan,
      subject: parsed.data.subject,
      body: parsed.data.body,
      requestOnboardingCall: parsed.data.requestOnboardingCall,
    });

    return reply.code(201).send({
      ticket: {
        id: ticket.id,
        subject: ticket.subject,
        status: ticket.status,
        slaHours: ticket.sla_hours,
        dueAt: ticket.due_at,
        onboardingCall: ticket.onboarding_call,
        createdAt: ticket.created_at,
      },
    });
  });

  // ---- GET /support/tickets ----------------------------------------------
  app.get('/support/tickets', { preHandler: app.authenticate }, async (request) => {
    const tickets = await listTickets(app.supabase, request.authUser!.userId);
    return {
      tickets: tickets.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        slaHours: t.sla_hours,
        dueAt: t.due_at,
        firstResponseAt: t.first_response_at,
        onboardingCall: t.onboarding_call,
        createdAt: t.created_at,
      })),
    };
  });

  // ---- GET /support/tickets/:id ------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/support/tickets/:id',
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (!z.string().uuid().safeParse(request.params.id).success) {
        return reply.code(400).send({ error: 'Invalid ticket id' });
      }
      const ticket = await getTicket(app.supabase, request.authUser!.userId, request.params.id);
      if (!ticket) return reply.code(404).send({ error: 'ไม่พบตั๋วนี้น้า' });
      return reply.send({ ticket });
    },
  );
};

export default supportRoutes;
