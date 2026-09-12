import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { prisma, Severity } from '@ai-dev-team/db';
import { LLMTimeoutError } from '@ai-dev-team/llm-gateway';
import { buildApp } from './app.js';
import { closeQueues } from './queue.js';
import { processFixerJob } from './queues/approval-loop.js';

describe('Health Checks & Timeout Error Handling (Prompt 10.2)', () => {
  let app: FastifyInstance;
  let testProjectId: string;
  let testTicketId: string;
  const originalOllamaUrl = process.env.OLLAMA_BASE_URL;

  beforeAll(async () => {
    app = buildApp({ logger: false });
    await app.ready();

    // Create test project and ticket
    const project = await prisma.project.create({
      data: {
        name: `health-test-${Date.now()}`,
        localPath: '/tmp/health-test-project'
      }
    });
    testProjectId = project.id;

    const file = await prisma.file.create({
      data: {
        projectId: testProjectId,
        path: 'src/calc.ts'
      }
    });

    const ticket = await prisma.ticket.create({
      data: {
        projectId: testProjectId,
        symptomFileId: file.id,
        title: 'Timeout test defect',
        description: 'Testing forced LLM timeout error handling',
        severity: Severity.medium,
        confidence: 0.9,
        status: 'approved',
        scannerModel: 'qwen3:8b'
      }
    });
    testTicketId = ticket.id;
  });

  afterAll(async () => {
    if (originalOllamaUrl) {
      process.env.OLLAMA_BASE_URL = originalOllamaUrl;
    } else {
      delete process.env.OLLAMA_BASE_URL;
    }

    if (testProjectId) {
      await prisma.project.delete({
        where: { id: testProjectId }
      }).catch(() => {});
    }
    await app.close();
    await closeQueues();
    await prisma.$disconnect();
  });

  describe('GET /health Dependency Status', () => {
    it('returns per-dependency status with latency for Postgres and Redis', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health'
      });

      expect([200, 503]).toContain(response.statusCode);
      const body = JSON.parse(response.body);

      expect(body.dependencies).toBeDefined();
      expect(body.dependencies.postgres.status).toBe('up');
      expect(typeof body.dependencies.postgres.latencyMs).toBe('number');

      expect(body.dependencies.redis.status).toBe('up');
      expect(typeof body.dependencies.redis.latencyMs).toBe('number');

      expect(body.dependencies.ollama).toBeDefined();
      expect(['up', 'down']).toContain(body.dependencies.ollama.status);
    });

    it('correctly reports Ollama as down and overall status as degraded when Ollama is unreachable', async () => {
      // Simulate stopped/unreachable Ollama service
      process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:59999';

      const response = await app.inject({
        method: 'GET',
        url: '/health'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.status).toBe('degraded');
      expect(body.dependencies.postgres.status).toBe('up');
      expect(body.dependencies.redis.status).toBe('up');
      expect(body.dependencies.ollama.status).toBe('down');
      expect(body.dependencies.ollama.error).toBeDefined();

      // Reset
      delete process.env.OLLAMA_BASE_URL;
    });
  });

  describe('Forced Ollama Timeout Error Handling', () => {
    it('sets ticket status to fix_timeout and writes an AuditLog entry when inference times out', async () => {
      // Mock runFixer to simulate a hanging Ollama call hitting the timeout
      const mockHangingFixer = async () => {
        throw new LLMTimeoutError(
          'Ollama inference timed out after 50ms for model qwen3-coder:30b',
          50,
          'qwen3-coder:30b'
        );
      };

      await expect(
        processFixerJob(
          { ticketId: testTicketId, projectId: testProjectId },
          { prisma, runFixerFn: mockHangingFixer, autoProgress: false }
        )
      ).rejects.toThrow(/timed out/);

      // Verify ticket reached distinct 'fix_timeout' status (not generic 'failed')
      const updatedTicket = await prisma.ticket.findUnique({
        where: { id: testTicketId }
      });
      expect(updatedTicket?.status).toBe('fix_timeout');

      // Verify AuditLog was written with error details and actor
      const auditLog = await prisma.auditLog.findFirst({
        where: {
          ticketId: testTicketId,
          action: 'fix_timeout'
        }
      });
      expect(auditLog).toBeDefined();
      expect(auditLog?.actor).toBe('fixer');
      expect((auditLog?.details as any)?.error).toContain('timed out');
    });
  });
});
