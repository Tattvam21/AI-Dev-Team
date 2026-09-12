import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma, Severity } from '@ai-dev-team/db';
import { runTriage, linesOverlap, partitionDuplicateTickets } from './triage.js';

describe('Triage Agent', () => {
  let testProjectId: string;
  let testFileId: string;

  beforeAll(async () => {
    const project = await prisma.project.create({
      data: {
        name: `triage-test-${Date.now()}`,
        localPath: '/tmp/test-project'
      }
    });
    testProjectId = project.id;

    const file = await prisma.file.create({
      data: {
        projectId: testProjectId,
        path: 'src/utils.ts'
      }
    });
    testFileId = file.id;
  });

  afterAll(async () => {
    if (testProjectId) {
      await prisma.project.delete({
        where: { id: testProjectId }
      });
    }
    await prisma.$disconnect();
  });

  describe('linesOverlap', () => {
    it('correctly identifies overlapping and non-overlapping line ranges', () => {
      expect(
        linesOverlap({ lineStart: 10, lineEnd: 20 }, { lineStart: 15, lineEnd: 25 })
      ).toBe(true);

      expect(
        linesOverlap({ lineStart: 10, lineEnd: 15 }, { lineStart: 15, lineEnd: 20 })
      ).toBe(true);

      expect(
        linesOverlap({ lineStart: 10, lineEnd: 20 }, { lineStart: 25, lineEnd: 30 })
      ).toBe(false);

      expect(
        linesOverlap({ lineStart: 10, lineEnd: null }, { lineStart: 10, lineEnd: 10 })
      ).toBe(true);

      expect(
        linesOverlap({ lineStart: null, lineEnd: null }, { lineStart: null, lineEnd: null })
      ).toBe(true);

      expect(
        linesOverlap({ lineStart: 10, lineEnd: 20 }, { lineStart: null, lineEnd: null })
      ).toBe(false);
    });
  });

  describe('runTriage workflow', () => {
    it('merges overlapping duplicates, re-scores surviving tickets with LLM, and sets status to triaged', async () => {
      // 1. Create two overlapping fixture tickets and one distinct one
      // Overlapping pair on lines 10-25: Ticket 1 (conf 0.90) vs Ticket 2 (conf 0.70)
      const ticket1 = await prisma.ticket.create({
        data: {
          projectId: testProjectId,
          symptomFileId: testFileId,
          lineStart: 10,
          lineEnd: 20,
          title: 'Potential null pointer in parseConfig',
          description: 'config might be null when accessed',
          severity: Severity.medium,
          confidence: 0.9,
          status: 'found',
          scannerModel: 'qwen3:8b'
        }
      });

      const ticket2 = await prisma.ticket.create({
        data: {
          projectId: testProjectId,
          symptomFileId: testFileId,
          lineStart: 15,
          lineEnd: 25,
          title: 'Unchecked property access on config object',
          description: 'config.options is dereferenced without check',
          severity: Severity.low,
          confidence: 0.7,
          status: 'found',
          scannerModel: 'eslint'
        }
      });

      // Distinct ticket on lines 60-70
      const ticket3 = await prisma.ticket.create({
        data: {
          projectId: testProjectId,
          symptomFileId: testFileId,
          lineStart: 60,
          lineEnd: 70,
          title: 'Resource leak in readFileStream',
          description: 'File stream is never closed in finally block',
          severity: Severity.high,
          confidence: 0.85,
          status: 'found',
          scannerModel: 'qwen3:8b'
        }
      });

      // Mock LLM client to re-score surviving tickets (ticket1 and ticket3)
      const mockChat = vi.fn().mockResolvedValue({
        message: {
          role: 'assistant',
          content: JSON.stringify({
            tickets: [
              {
                id: ticket1.id,
                severity: 'high',
                confidence: 0.95,
                reasoning: 'Confirmed critical null pointer that will crash on startup'
              },
              {
                id: ticket3.id,
                severity: 'critical',
                confidence: 0.92,
                reasoning: 'Confirmed severe resource descriptor exhaustion'
              }
            ]
          })
        }
      });

      const mockLlmClient = { chat: mockChat };

      // Execute triage
      await runTriage(testProjectId, {
        prisma,
        llmClient: mockLlmClient
      });

      // Verify tickets in database
      const [updatedTicket1, updatedTicket2, updatedTicket3] = await Promise.all([
        prisma.ticket.findUniqueOrThrow({ where: { id: ticket1.id } }),
        prisma.ticket.findUniqueOrThrow({ where: { id: ticket2.id } }),
        prisma.ticket.findUniqueOrThrow({ where: { id: ticket3.id } })
      ]);

      // Ticket 2 (lower confidence duplicate) must be marked 'merged_duplicate'
      expect(updatedTicket2.status).toBe('merged_duplicate');

      // Ticket 1 (higher confidence surviving ticket) must be 'triaged' and re-scored
      expect(updatedTicket1.status).toBe('triaged');
      expect(updatedTicket1.severity).toBe(Severity.high);
      expect(updatedTicket1.confidence).toBe(0.95);

      // Ticket 3 (distinct ticket) must be 'triaged' and re-scored
      expect(updatedTicket3.status).toBe('triaged');
      expect(updatedTicket3.severity).toBe(Severity.critical);
      expect(updatedTicket3.confidence).toBe(0.92);

      // Confirm LLM was called with the 2 surviving tickets
      expect(mockChat).toHaveBeenCalledTimes(1);
    });

    it('gracefully handles projects with no found tickets', async () => {
      const emptyProject = await prisma.project.create({
        data: {
          name: `empty-test-${Date.now()}`
        }
      });

      await expect(runTriage(emptyProject.id, { prisma })).resolves.toBeUndefined();

      await prisma.project.delete({
        where: { id: emptyProject.id }
      });
    });
  });
});
