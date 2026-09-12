import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@ai-dev-team/db';
import {
  validateTicketTransition,
  transitionTicket,
  InvalidStateTransitionError
} from '../state-machine.js';
import { enqueueFixerJob } from '../queue.js';

export const ticketRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /tickets/:id - Get ticket details
  fastify.get('/tickets/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const ticket = await prisma.ticket.findUnique({
      where: { id },
      include: {
        symptomFile: true,
        rootCauseFile: true,
        patches: {
          orderBy: { createdAt: 'desc' }
        },
        auditLogs: {
          orderBy: { createdAt: 'asc' }
        }
      }
    });

    if (!ticket) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Ticket with id '${id}' not found`
      });
    }

    return reply.send(ticket);
  });

  // GET /tickets/:id/audit - Get complete, ordered history of audit logs
  fastify.get('/tickets/:id/audit', async (request, reply) => {
    const { id } = request.params as { id: string };

    const ticket = await prisma.ticket.findUnique({
      where: { id }
    });

    if (!ticket) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Ticket with id '${id}' not found`
      });
    }

    const auditLogs = await prisma.auditLog.findMany({
      where: { ticketId: id },
      orderBy: { createdAt: 'asc' }
    });

    return reply.send(auditLogs);
  });

  // POST /tickets/:id/approve - Approve ticket (must be 'triaged') and enqueue fixer job
  fastify.post('/tickets/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string };

    const ticket = await prisma.ticket.findUnique({
      where: { id }
    });

    if (!ticket) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Ticket with id '${id}' not found`
      });
    }

    // Strict validation: must be 'triaged'
    if (ticket.status !== 'triaged') {
      throw new InvalidStateTransitionError(
        'ticket',
        ticket.status,
        'approved',
        `Cannot approve ticket with status '${ticket.status}'. Tickets must be 'triaged' before approval.`
      );
    }

    // Centrally transition state and write AuditLog row + broadcast via WebSocket
    const { ticket: updatedTicket } = await transitionTicket(ticket.id, 'approved', {
      actor: 'human',
      action: 'approved'
    });

    // Enqueue fixer job
    const job = await enqueueFixerJob(updatedTicket.id, updatedTicket.projectId);

    return reply.send({
      ticket: updatedTicket,
      jobId: job.id,
      message: 'Ticket approved and fixer job enqueued'
    });
  });

  // POST /tickets/:id/reject - Reject ticket
  fastify.post('/tickets/:id/reject', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as { reason?: string }) || {};

    const ticket = await prisma.ticket.findUnique({
      where: { id }
    });

    if (!ticket) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Ticket with id '${id}' not found`
      });
    }

    // Centrally transition state and write AuditLog row + broadcast via WebSocket
    const { ticket: updatedTicket } = await transitionTicket(ticket.id, 'rejected', {
      actor: 'human',
      action: 'rejected',
      details: {
        reason: body.reason ?? null
      }
    });

    return reply.send({
      ticket: updatedTicket,
      message: 'Ticket rejected'
    });
  });

  // GET /tickets/:id/patch - Get current patch for a ticket
  fastify.get('/tickets/:id/patch', async (request, reply) => {
    const { id } = request.params as { id: string };

    const ticket = await prisma.ticket.findUnique({
      where: { id }
    });

    if (!ticket) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Ticket with id '${id}' not found`
      });
    }

    const latestPatch = await prisma.patch.findFirst({
      where: { ticketId: id },
      orderBy: { createdAt: 'desc' },
      include: {
        reviews: { orderBy: { reviewedAt: 'desc' } },
        testRuns: { orderBy: { ranAt: 'desc' } }
      }
    });

    if (!latestPatch) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `No patch found for ticket '${id}'`
      });
    }

    return reply.send(latestPatch);
  });

  // GET /tickets/:id/reviews - Return all Review rows for a ticket's latest patch
  fastify.get('/tickets/:id/reviews', async (request, reply) => {
    const { id } = request.params as { id: string };

    const ticket = await prisma.ticket.findUnique({
      where: { id }
    });

    if (!ticket) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Ticket with id '${id}' not found`
      });
    }

    const latestPatch = await prisma.patch.findFirst({
      where: { ticketId: id },
      orderBy: { createdAt: 'desc' }
    });

    if (!latestPatch) {
      return reply.send([]);
    }

    const reviews = await prisma.review.findMany({
      where: { patchId: latestPatch.id },
      orderBy: [
        { is_final_verdict: 'asc' },
        { council_member: 'asc' },
        { reviewedAt: 'asc' }
      ]
    });

    return reply.send(reviews);
  });
};
