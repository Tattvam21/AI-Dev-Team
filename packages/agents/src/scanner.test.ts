import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { prisma } from '@ai-dev-team/db';
import { runScan } from './scanner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Scanner Agent', () => {
  const fixtureProjectRoot = path.join(__dirname, '__fixtures__/scanner-project');
  let testProjectId: string;

  beforeAll(async () => {
    const project = await prisma.project.create({
      data: {
        name: `scanner-test-${Date.now()}`,
        localPath: fixtureProjectRoot
      }
    });
    testProjectId = project.id;
  });

  afterAll(async () => {
    if (testProjectId) {
      await prisma.project.delete({
        where: { id: testProjectId }
      });
    }
    await prisma.$disconnect();
  });

  it('should scan fixture project, producing tickets for both lint issue and logic bug', async () => {
    // Mock LLM client for logic-bug.js
    const mockChat = vi.fn().mockResolvedValue({
      message: {
        role: 'assistant',
        content: JSON.stringify({
          title: 'Missing null check before .map()',
          description: 'processItems will throw TypeError if items is null or undefined.',
          severity: 'high',
          confidence: 0.92,
          rootCauseFile: 'logic-bug.js'
        })
      }
    });

    const mockLlmClient = { chat: mockChat };

    const tickets = await runScan(testProjectId, {
      prisma,
      model: 'qwen3:8b',
      llmClient: mockLlmClient
    });

    expect(tickets.length).toBeGreaterThanOrEqual(2);

    // 1. Lint ticket
    const lintTicket = tickets.find((t) => t.scannerModel === 'eslint');
    expect(lintTicket).toBeDefined();
    expect(lintTicket!.title).toContain('no-unused-vars');
    expect(lintTicket!.description).toContain('unusedApiKey');
    expect(lintTicket!.confidence).toBe(1.0);
    expect(lintTicket!.status).toBe('found');

    // 2. Logic bug ticket from LLM pass
    const logicTicket = tickets.find((t) => t.scannerModel === 'qwen3:8b');
    expect(logicTicket).toBeDefined();
    expect(logicTicket!.title).toBe('Missing null check before .map()');
    expect(logicTicket!.description).toContain('TypeError');
    expect(logicTicket!.confidence).toBe(0.92);
    expect(logicTicket!.severity).toBe('high');
    expect(logicTicket!.status).toBe('found');
    expect(logicTicket!.symptomFileId).toBeDefined();
    expect(logicTicket!.rootCauseFileId).toBeDefined();

    // Confirm LLM was called only for logic-bug.js, not for lint-bug.js
    expect(mockChat).toHaveBeenCalledTimes(1);
  });
});
