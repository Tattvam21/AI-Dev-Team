import { FastifyPluginAsync } from 'fastify';
import { prisma, Severity } from '@ai-dev-team/db';
import { enqueueScanJob } from '../queue.js';

export const projectRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /projects - Register a new project
  fastify.post('/projects', async (request, reply) => {
    const body = request.body as {
      name?: string;
      localPath?: string;
      githubRepo?: string;
    };

    if (!body || !body.name || typeof body.name !== 'string' || body.name.trim() === '') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Project name is required'
      });
    }

    const project = await prisma.project.create({
      data: {
        name: body.name.trim(),
        localPath: body.localPath?.trim() || null,
        githubRepo: body.githubRepo?.trim() || null
      }
    });

    return reply.status(201).send(project);
  });

  // GET /projects - List all registered projects
  fastify.get('/projects', async (_request, reply) => {
    const projects = await prisma.project.findMany({
      include: {
        _count: {
          select: { tickets: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    return reply.send(projects);
  });


  // POST /projects/:id/scan - Enqueue scan job
  fastify.post('/projects/:id/scan', async (request, reply) => {
    const { id } = request.params as { id: string };

    const project = await prisma.project.findUnique({
      where: { id }
    });

    if (!project) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Project with id '${id}' not found`
      });
    }

    const job = await enqueueScanJob(project.id);

    return reply.status(202).send({
      success: true,
      message: 'Scan job enqueued',
      jobId: job.id,
      projectId: project.id
    });
  });

  // GET /projects/:id/tickets - List tickets, filterable by status/severity
  fastify.get('/projects/:id/tickets', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as {
      status?: string;
      severity?: string;
    };

    const project = await prisma.project.findUnique({
      where: { id }
    });

    if (!project) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Project with id '${id}' not found`
      });
    }

    const whereClause: any = { projectId: id };

    if (query.status) {
      whereClause.status = query.status;
    }

    if (query.severity) {
      if (Object.values(Severity).includes(query.severity as Severity)) {
        whereClause.severity = query.severity as Severity;
      } else {
        return reply.status(400).send({
          error: 'Bad Request',
          message: `Invalid severity '${query.severity}'. Allowed: ${Object.values(Severity).join(', ')}`
        });
      }
    }

    const tickets = await prisma.ticket.findMany({
      where: whereClause,
      include: {
        symptomFile: {
          select: { id: true, path: true }
        },
        rootCauseFile: {
          select: { id: true, path: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    return reply.send(tickets);
  });
};
