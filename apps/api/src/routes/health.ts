import { FastifyPluginAsync } from 'fastify';
import { prisma } from '@ai-dev-team/db';
import { Redis } from 'ioredis';

export interface DependencyHealth {
  status: 'up' | 'down';
  latencyMs?: number;
  error?: string;
  version?: string;
}

export interface HealthCheckResponse {
  status: 'ok' | 'degraded' | 'error';
  dependencies: {
    postgres: DependencyHealth;
    redis: DependencyHealth;
    ollama: DependencyHealth;
  };
  timestamp: string;
}

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async (_request, reply) => {
    const timestamp = new Date().toISOString();

    // 1. Check PostgreSQL
    const pgStart = Date.now();
    let pgHealth: DependencyHealth;
    try {
      await prisma.$queryRaw`SELECT 1`;
      pgHealth = {
        status: 'up',
        latencyMs: Date.now() - pgStart
      };
    } catch (err: any) {
      pgHealth = {
        status: 'down',
        latencyMs: Date.now() - pgStart,
        error: err.message
      };
    }

    // 2. Check Redis
    const redisStart = Date.now();
    let redisHealth: DependencyHealth;
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    let redisClient: Redis | null = null;
    try {
      redisClient = new Redis(redisUrl, {
        connectTimeout: 2000,
        maxRetriesPerRequest: 1,
        lazyConnect: true
      });
      await redisClient.connect();
      await redisClient.ping();
      redisHealth = {
        status: 'up',
        latencyMs: Date.now() - redisStart
      };
    } catch (err: any) {
      redisHealth = {
        status: 'down',
        latencyMs: Date.now() - redisStart,
        error: err.message
      };
    } finally {
      if (redisClient) {
        try {
          redisClient.disconnect();
        } catch {}
      }
    }

    // 3. Check Ollama
    const ollamaStart = Date.now();
    let ollamaHealth: DependencyHealth;
    const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    try {
      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => controller.abort(), 3000);

      const res = await fetch(`${ollamaUrl}/api/version`, {
        signal: controller.signal
      });
      clearTimeout(timeoutTimer);

      if (res.ok) {
        const data = (await res.json()) as any;
        ollamaHealth = {
          status: 'up',
          version: data.version ?? 'unknown',
          latencyMs: Date.now() - ollamaStart
        };
      } else {
        ollamaHealth = {
          status: 'down',
          latencyMs: Date.now() - ollamaStart,
          error: `Ollama returned HTTP ${res.status}`
        };
      }
    } catch (err: any) {
      ollamaHealth = {
        status: 'down',
        latencyMs: Date.now() - ollamaStart,
        error:
          err.name === 'AbortError'
            ? 'Ollama health check timed out after 3000ms'
            : err.message
      };
    }

    // Aggregate Status:
    // If all up -> ok
    // If Ollama is down but PG + Redis are up -> degraded
    // If PG or Redis is down -> error
    let overallStatus: 'ok' | 'degraded' | 'error' = 'ok';
    if (pgHealth.status === 'down' || redisHealth.status === 'down') {
      overallStatus = 'error';
    } else if (ollamaHealth.status === 'down') {
      overallStatus = 'degraded';
    }

    const statusCode = overallStatus === 'error' ? 503 : 200;

    const response: HealthCheckResponse = {
      status: overallStatus,
      dependencies: {
        postgres: pgHealth,
        redis: redisHealth,
        ollama: ollamaHealth
      },
      timestamp
    };

    return reply.status(statusCode).send(response);
  });
};
