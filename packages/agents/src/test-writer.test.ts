import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { simpleGit } from 'simple-git';
import { prisma, Severity } from '@ai-dev-team/db';
import { runFixer } from './fixer.js';
import { runTestWriter } from './test-writer.js';

describe('Test-Writer Agent', () => {
  let tempRepoPath: string;
  let testProjectId: string;
  let testFileId: string;
  let testPatchId: string;
  let testTicketId: string;

  beforeAll(async () => {
    // 1. Create a git repo fixture
    tempRepoPath = path.join(os.tmpdir(), `test-writer-fixture-${Date.now()}`);
    fs.mkdirSync(path.join(tempRepoPath, 'src'), { recursive: true });

    const git = simpleGit(tempRepoPath);
    await git.init(['-b', 'main']);
    await git.addConfig('user.name', 'TestWriter Agent');
    await git.addConfig('user.email', 'testwriter@agent.local');

    // Buggy code
    const originalFileContent = `export function calculateTotal(price: number, tax: number): number {\n  return price - tax;\n}\n`;
    fs.writeFileSync(
      path.join(tempRepoPath, 'src/calculator.ts'),
      originalFileContent,
      'utf-8'
    );

    await git.add('.');
    await git.commit('Initial buggy calculator commit');

    // 2. Setup project and file in DB
    const project = await prisma.project.create({
      data: {
        name: `testwriter-project-${Date.now()}`,
        localPath: tempRepoPath
      }
    });
    testProjectId = project.id;

    const file = await prisma.file.create({
      data: {
        projectId: testProjectId,
        path: 'src/calculator.ts'
      }
    });
    testFileId = file.id;

    // 3. Create approved ticket
    const ticket = await prisma.ticket.create({
      data: {
        projectId: testProjectId,
        symptomFileId: testFileId,
        rootCauseFileId: testFileId,
        lineStart: 2,
        lineEnd: 2,
        title: 'Fix calculateTotal subtraction bug',
        description: 'calculateTotal subtracts tax instead of adding.',
        severity: Severity.high,
        confidence: 0.98,
        status: 'approved',
        scannerModel: 'qwen3:8b'
      }
    });
    testTicketId = ticket.id;

    // 4. Run Fixer to produce initial patch & branch commit
    const fixerDiff = `--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@ -1,3 +1,3 @@\n export function calculateTotal(price: number, tax: number): number {\n-  return price - tax;\n+  return price + tax;\n }\n`;
    const fixedContent = `export function calculateTotal(price: number, tax: number): number {\n  return price + tax;\n}\n`;

    const mockFixerChat = vi.fn().mockResolvedValue({
      message: {
        role: 'assistant',
        content: JSON.stringify({
          diff: fixerDiff,
          rationale: 'Changed subtraction to addition',
          updatedContent: fixedContent
        })
      }
    });

    const patch = await runFixer(ticket.id, {
      prisma,
      model: 'qwen3-coder:30b',
      llmClient: { chat: mockFixerChat }
    });
    testPatchId = patch.id;
  });

  afterAll(async () => {
    if (testProjectId) {
      await prisma.project.delete({
        where: { id: testProjectId }
      });
    }
    if (tempRepoPath && fs.existsSync(tempRepoPath)) {
      await fs.promises.rm(tempRepoPath, { recursive: true, force: true }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it('generates regression tests, writes file into worktree, and creates second commit on branch', async () => {
    const generatedTestContent = `import assert from 'assert';\nimport { calculateTotal } from './calculator.js';\n\nassert.strictEqual(calculateTotal(100, 15), 115);\nconsole.log('calculateTotal tests pass');\n`;

    const mockTestWriterChat = vi.fn().mockResolvedValue({
      message: {
        role: 'assistant',
        content: JSON.stringify({
          testFilePath: 'src/calculator.test.ts',
          testFileContent: generatedTestContent
        })
      }
    });

    const mockLlmClient = { chat: mockTestWriterChat };

    // Execute Test-Writer
    await runTestWriter(testPatchId, {
      prisma,
      model: 'qwen3:8b',
      llmClient: mockLlmClient
    });

    // 1. Verify LLM was invoked with test-writer prompt
    expect(mockTestWriterChat).toHaveBeenCalledTimes(1);

    // 2. Fetch patch to get branch name
    const patch = await prisma.patch.findUniqueOrThrow({
      where: { id: testPatchId }
    });

    // 3. Inspect git branch log to confirm second commit exists
    const rootGit = simpleGit(tempRepoPath);
    const log = await rootGit.log([patch.branchName, '-n', '5']);

    expect(log.total).toBeGreaterThanOrEqual(2);

    const latestCommit = log.latest;
    expect(latestCommit?.message).toContain('test: add regression tests for Fix calculateTotal subtraction bug');

    const previousCommit = log.all[1];
    expect(previousCommit?.message).toContain('fix(calculator.ts): Fix calculateTotal subtraction bug');

    // 4. Inspect file content on the branch using git show
    const fileContentOnBranch = await rootGit.show([`${patch.branchName}:src/calculator.test.ts`]);
    expect(fileContentOnBranch).toBe(generatedTestContent);
    expect(fileContentOnBranch).toContain('calculateTotal(100, 15), 115');
  });
});
