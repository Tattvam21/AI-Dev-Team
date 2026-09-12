import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { prisma, Severity } from '@ai-dev-team/db';
import { buildApp } from './app.js';
import { closeQueues } from './queue.js';
import { transitionTicket } from './state-machine.js';
import { clearSubscribers } from './ws.js';

describe('Audit Log & WebSocket Live Updates Integration', () => {
  let app: FastifyInstance;
  let serverAddress: string;
  let testProjectId: string;
  let testTicketId: string;

  beforeAll(async () => {
    app = buildApp({ logger: false });
    // Listen on random port to test real WebSocket connection
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as any;
    serverAddress = `127.0.0.1:${address.port}`;

    // Create test project
    const project = await prisma.project.create({
      data: {
        name: `audit-ws-project-${Date.now()}`,
        localPath: '/tmp/audit-ws-project'
      }
    });
    testProjectId = project.id;

    const file = await prisma.file.create({
      data: {
        projectId: testProjectId,
        path: 'src/handler.ts'
      }
    });

    const ticket = await prisma.ticket.create({
      data: {
        projectId: testProjectId,
        symptomFileId: file.id,
        title: 'Uncaught TypeError in request handler',
        description: 'Handler throws undefined reading headers',
        severity: Severity.high,
        confidence: 0.88,
        status: 'found',
        scannerModel: 'qwen3:8b'
      }
    });
    testTicketId = ticket.id;
  });

  afterAll(async () => {
    clearSubscribers();
    if (testProjectId) {
      await prisma.project.delete({
        where: { id: testProjectId }
      }).catch(() => {});
    }
    await app.close();
    await closeQueues();
    await prisma.$disconnect();
  });

  describe('Centralized AuditLog in state-machine', () => {
    it('records an AuditLog row on every state transition from transitionTicket', async () => {
      // 1. Transition found -> triaged
      const { ticket: triagedTicket, auditLog: audit1 } = await transitionTicket(
        testTicketId,
        'triaged',
        {
          actor: 'triage-agent',
          action: 'triaged',
          details: { confidence: 0.9 }
        }
      );

      expect(triagedTicket.status).toBe('triaged');
      expect(audit1.actor).toBe('triage-agent');
      expect(audit1.action).toBe('triaged');
      expect((audit1.details as any).previousStatus).toBe('found');
      expect((audit1.details as any).newStatus).toBe('triaged');

      // 2. Transition triaged -> approved via API route
      const approveRes = await app.inject({
        method: 'POST',
        url: `/tickets/${testTicketId}/approve`
      });

      expect(approveRes.statusCode).toBe(200);
      const approveBody = JSON.parse(approveRes.body);
      expect(approveBody.ticket.status).toBe('approved');

      // 3. Verify audit log was recorded for approved transition
      const auditLogs = await prisma.auditLog.findMany({
        where: { ticketId: testTicketId },
        orderBy: { createdAt: 'asc' }
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(2);
      const lastLog = auditLogs[auditLogs.length - 1];
      expect(lastLog.actor).toBe('human');
      expect(lastLog.action).toBe('approved');
      expect((lastLog.details as any).previousStatus).toBe('triaged');
      expect((lastLog.details as any).newStatus).toBe('approved');
    });

    it('GET /tickets/:id/audit returns a complete, chronologically ordered history', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/tickets/${testTicketId}/audit`
      });

      expect(response.statusCode).toBe(200);
      const logs = JSON.parse(response.body);

      expect(Array.isArray(logs)).toBe(true);
      expect(logs.length).toBeGreaterThanOrEqual(2);

      // Verify ascending order
      for (let i = 1; i < logs.length; i++) {
        const prevTime = new Date(logs[i - 1].createdAt).getTime();
        const currTime = new Date(logs[i].createdAt).getTime();
        expect(currTime).toBeGreaterThanOrEqual(prevTime);
      }

      expect(logs[0].action).toBe('triaged');
      expect(logs[1].action).toBe('approved');
    });
  });

  describe('WebSocket /ws/projects/:id Endpoint', () => {
    it('connects to /ws/projects/:id, receives connected ack and ping/pong', async () => {
      const wsUrl = `ws://${serverAddress}/ws/projects/${testProjectId}`;
      const ws = new WebSocket(wsUrl);

      const messages: any[] = [];

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WebSocket connection timed out')), 4000);

        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'ping' }));
        };

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data.toString());
          messages.push(data);
          if (messages.length >= 2) {
            clearTimeout(timeout);
            resolve();
          }
        };

        ws.onerror = (err) => {
          clearTimeout(timeout);
          reject(err);
        };
      });

      expect(messages[0].type).toBe('connected');
      expect(messages[0].projectId).toBe(testProjectId);
      expect(messages[1].type).toBe('pong');

      ws.close();
    });

    it('broadcasts ticket state-change events live to connected clients upon approval', async () => {
      // Create a new ticket in 'triaged' state for live testing
      const file = await prisma.file.findFirst({ where: { projectId: testProjectId } });
      const liveTicket = await prisma.ticket.create({
        data: {
          projectId: testProjectId,
          symptomFileId: file!.id,
          title: 'Live WebSocket test ticket',
          description: 'Testing live push updates without refresh',
          severity: Severity.medium,
          confidence: 0.9,
          status: 'triaged',
          scannerModel: 'qwen3:8b'
        }
      });

      const wsUrl = `ws://${serverAddress}/ws/projects/${testProjectId}`;
      const ws = new WebSocket(wsUrl);

      // Wait for connection to establish
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Socket open timeout')), 3000);
        ws.onopen = () => {
          clearTimeout(timeout);
          resolve();
        };
        ws.onerror = (err) => {
          clearTimeout(timeout);
          reject(err);
        };
      });

      // Prepare promise waiting for the live 'ticket_updated' broadcast event
      const broadcastReceivedPromise = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Broadcast message not received')), 4000);

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data.toString());
            if (data.type === 'ticket_updated' && data.ticketId === liveTicket.id) {
              clearTimeout(timeout);
              resolve(data);
            }
          } catch {}
        };
      });

      // Approve ticket via API endpoint (simulating user clicking Approve in Tab 1)
      const approveRes = await app.inject({
        method: 'POST',
        url: `/tickets/${liveTicket.id}/approve`
      });
      expect(approveRes.statusCode).toBe(200);

      // Verify that Tab 2 (the WebSocket client) receives the live broadcast immediately
      const broadcastEvent = await broadcastReceivedPromise;
      expect(broadcastEvent.type).toBe('ticket_updated');
      expect(broadcastEvent.ticketId).toBe(liveTicket.id);
      expect(broadcastEvent.status).toBe('approved');
      expect(broadcastEvent.actor).toBe('human');
      expect(broadcastEvent.ticket.title).toBe('Live WebSocket test ticket');

      ws.close();
    });
  });
});
