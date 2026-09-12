import Fastify, { FastifyInstance } from 'fastify';
import { projectRoutes } from './routes/projects.js';
import { ticketRoutes } from './routes/tickets.js';
import { patchRoutes } from './routes/patches.js';
import { healthRoutes } from './routes/health.js';
import { wsRoutes } from './ws.js';
import { fsRoutes } from './routes/fs.js';
import { InvalidStateTransitionError } from './state-machine.js';

export interface BuildAppOptions {
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false
  });

  // Support empty JSON bodies gracefully
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      const trimmed = (body as string)?.trim();
      const json = trimmed ? JSON.parse(trimmed) : {};
      done(null, json);
    } catch (err: any) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });


  // Global Error Handler
  app.setErrorHandler((error: any, _request, reply) => {
    if (error instanceof InvalidStateTransitionError || error?.statusCode === 409) {
      return reply.status(409).send({
        error: 'Conflict',
        message: error.message,
        statusCode: 409
      });
    }

    if ((error as any).statusCode) {
      return reply.status((error as any).statusCode).send({
        error: error.name || 'Error',
        message: error.message,
        statusCode: (error as any).statusCode
      });
    }

    reply.status(500).send({
      error: 'Internal Server Error',
      message: error.message,
      statusCode: 500
    });
  });

  // Register domain and health routes
  app.register(healthRoutes);
  app.register(wsRoutes);
  app.register(fsRoutes);
  app.register(projectRoutes);
  app.register(ticketRoutes);
  app.register(patchRoutes);


  return app;
}
