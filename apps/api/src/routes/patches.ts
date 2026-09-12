import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@ai-dev-team/db';
import {
  finalizeLocalCommits,
  pushAndCreatePullRequest,
  finalizeAndSync,
  exportPatchDiff,
  generateManualApplyInstructions
} from '@ai-dev-team/agents';
import { validatePatchTransition } from '../state-machine.js';

export const patchRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /patches/:id - Get patch details
  fastify.get('/patches/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const patch = await prisma.patch.findUnique({
      where: { id },
      include: {
        ticket: {
          include: {
            project: true
          }
        },
        reviews: { orderBy: { reviewedAt: 'desc' } },
        testRuns: { orderBy: { ranAt: 'desc' } }
      }
    });

    if (!patch) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Patch with id '${id}' not found`
      });
    }

    return reply.send(patch);
  });

  // GET /patches/:id/diff - Retrieve unified diff and manual apply instructions
  fastify.get('/patches/:id/diff', async (request, reply) => {
    const { id } = request.params as { id: string };

    const patch = await prisma.patch.findUnique({
      where: { id },
      include: {
        ticket: {
          include: {
            project: true
          }
        }
      }
    });

    if (!patch) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Patch with id '${id}' not found`
      });
    }

    const diff = await exportPatchDiff(id);
    const isLocalOnly = !patch.ticket.project.githubRepo;
    const manualApplyInstructions = isLocalOnly
      ? generateManualApplyInstructions(patch.branchName, diff)
      : undefined;

    const acceptHeader = request.headers['accept'] || '';
    if (acceptHeader.includes('text/plain')) {
      return reply.type('text/plain').send(diff);
    }

    return reply.send({
      patchId: patch.id,
      status: patch.status,
      branchName: patch.branchName,
      isLocalOnly,
      diff,
      manualApplyInstructions
    });
  });

  // GET /patches/:id/reviews - Return all Review rows for a given patch (council members & final aggregated row)
  fastify.get('/patches/:id/reviews', async (request, reply) => {
    const { id } = request.params as { id: string };

    const patch = await prisma.patch.findUnique({
      where: { id }
    });

    if (!patch) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Patch with id '${id}' not found`
      });
    }

    const reviews = await prisma.review.findMany({
      where: { patchId: id },
      orderBy: [
        { is_final_verdict: 'asc' },
        { council_member: 'asc' },
        { reviewedAt: 'asc' }
      ]
    });

    return reply.send(reviews);
  });

  // POST /patches/:id/finalize-local - Finalize local commits and transition to ready_to_push
  fastify.post('/patches/:id/finalize-local', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as { baseBranch?: string }) || {};

    const patch = await prisma.patch.findUnique({
      where: { id }
    });

    if (!patch) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Patch with id '${id}' not found`
      });
    }

    try {
      const result = await finalizeLocalCommits(id, {
        baseBranch: body.baseBranch
      });

      return reply.send({
        success: true,
        message: 'Local commits finalized successfully',
        patch: result
      });
    } catch (err: any) {
      return reply.status(400).send({
        error: 'Finalization Failed',
        message: err.message
      });
    }
  });

  // POST /patches/:id/push - Push branch to remote and create GitHub PR
  fastify.post('/patches/:id/push', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as { baseBranch?: string; githubToken?: string }) || {};

    const patch = await prisma.patch.findUnique({
      where: { id }
    });

    if (!patch) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Patch with id '${id}' not found`
      });
    }

    const result = await pushAndCreatePullRequest(id, {
      baseBranch: body.baseBranch,
      githubToken: body.githubToken
    });

    if (!result.success) {
      return reply.status(409).send({
        error: 'Push/Rebase Conflict',
        message: result.error,
        result
      });
    }

    return reply.send({
      success: true,
      message: 'Branch pushed and Pull Request opened',
      result
    });
  });

  // POST /patches/:id/sync - Unified sync (local or remote based on project githubRepo)
  fastify.post('/patches/:id/sync', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as { baseBranch?: string; githubToken?: string }) || {};

    const patch = await prisma.patch.findUnique({
      where: { id }
    });

    if (!patch) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Patch with id '${id}' not found`
      });
    }

    const result = await finalizeAndSync(id, {
      baseBranch: body.baseBranch,
      githubToken: body.githubToken
    });

    return reply.send({
      success: true,
      result
    });
  });

  // POST /patches/:id/approve - Human approves patch
  fastify.post('/patches/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as { finalize?: boolean; baseBranch?: string }) || {};

    const patch = await prisma.patch.findUnique({
      where: { id }
    });

    if (!patch) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Patch with id '${id}' not found`
      });
    }

    validatePatchTransition(patch.status, 'approved');

    const updatedPatch = await prisma.patch.update({
      where: { id },
      data: { status: 'approved' }
    });

    // Record audit log
    await prisma.auditLog.create({
      data: {
        ticketId: patch.ticketId,
        actor: 'human',
        action: 'patch_approved',
        details: {
          patchId: patch.id,
          previousStatus: patch.status,
          newStatus: 'approved'
        }
      }
    });

    // If finalize requested, finalize local commits immediately
    if (body.finalize) {
      try {
        const finalizeResult = await finalizeLocalCommits(id, {
          baseBranch: body.baseBranch
        });
        return reply.send({
          patch: finalizeResult,
          message: 'Patch approved and finalized to ready_to_push'
        });
      } catch (err: any) {
        return reply.status(400).send({
          error: 'Finalization Failed',
          message: err.message
        });
      }
    }

    return reply.send({
      patch: updatedPatch,
      message: 'Patch approved'
    });
  });

  // POST /patches/:id/reject - Human rejects patch
  fastify.post('/patches/:id/reject', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as { notes?: string }) || {};

    const patch = await prisma.patch.findUnique({
      where: { id }
    });

    if (!patch) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Patch with id '${id}' not found`
      });
    }

    validatePatchTransition(patch.status, 'rejected');

    const updatedPatch = await prisma.patch.update({
      where: { id },
      data: { status: 'rejected' }
    });

    // Record audit log
    await prisma.auditLog.create({
      data: {
        ticketId: patch.ticketId,
        actor: 'human',
        action: 'patch_rejected',
        details: {
          patchId: patch.id,
          previousStatus: patch.status,
          newStatus: 'rejected',
          notes: body.notes ?? null
        }
      }
    });

    return reply.send({
      patch: updatedPatch,
      message: 'Patch rejected'
    });
  });
};
