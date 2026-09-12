import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { simpleGit } from 'simple-git';
import { prisma, Severity } from '@ai-dev-team/db';
import { runFixer, applyPatchToFile } from './fixer.js';

describe('Fixer Agent', () => {
  let tempRepoPath: string;
  let testProjectId: string;
  let testFileId: string;

  beforeAll(async () => {
    // 1. Create a git repo fixture
    tempRepoPath = path.join(os.tmpdir(), `fixer-fixture-${Date.now()}`);
    fs.mkdirSync(path.join(tempRepoPath, 'src'), { recursive: true });

    const git = simpleGit(tempRepoPath);
    await git.init(['-b', 'main']);
    await git.addConfig('user.name', 'Fixer Test');
    await git.addConfig('user.email', 'fixer@test.local');

    // Buggy file: subtracts tax instead of adding tax
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
        name: `fixer-test-${Date.now()}`,
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

  describe('applyPatchToFile', () => {
    it('applies a standard unified diff', () => {
      const original = `line 1\nline 2\nline 3\n`;
      const unifiedDiff = `--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@\n line 1\n-line 2\n+line 2 modified\n line 3\n`;
      const testFile = path.join(os.tmpdir(), `test-patch-${Date.now()}.txt`);
      fs.writeFileSync(testFile, original, 'utf-8');

      try {
        const result = applyPatchToFile(testFile, original, unifiedDiff);
        expect(result.success).toBe(true);
        expect(result.method).toBe('diff');
        const updated = fs.readFileSync(testFile, 'utf-8');
        expect(updated).toBe(`line 1\nline 2 modified\nline 3\n`);
      } finally {
        fs.rmSync(testFile, { force: true });
      }
    });

    it('falls back to updatedContent when unified diff is invalid', () => {
      const original = `hello world\n`;
      const invalidDiff = `malformed hunk without proper diff structure`;
      const fullContent = `hello beautiful world\n`;
      const testFile = path.join(os.tmpdir(), `test-fallback-${Date.now()}.txt`);
      fs.writeFileSync(testFile, original, 'utf-8');

      try {
        const result = applyPatchToFile(testFile, original, invalidDiff, fullContent);
        expect(result.success).toBe(true);
        expect(result.method).toBe('updatedContent');
        const updated = fs.readFileSync(testFile, 'utf-8');
        expect(updated).toBe(fullContent);
      } finally {
        fs.rmSync(testFile, { force: true });
      }
    });
  });

  describe('runFixer', () => {
    it('creates worktree, generates patch via LLM, applies fix, commits, and creates Patch row', async () => {
      const ticket = await prisma.ticket.create({
        data: {
          projectId: testProjectId,
          symptomFileId: testFileId,
          rootCauseFileId: testFileId,
          lineStart: 2,
          lineEnd: 2,
          title: 'Incorrect tax calculation in calculateTotal',
          description: 'calculateTotal subtracts tax instead of adding tax.',
          severity: Severity.high,
          confidence: 0.98,
          status: 'approved',
          scannerModel: 'qwen3:8b'
        }
      });

      const fixedContent = `export function calculateTotal(price: number, tax: number): number {\n  return price + tax;\n}\n`;

      const unifiedDiff = `--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@ -1,3 +1,3 @@\n export function calculateTotal(price: number, tax: number): number {\n-  return price - tax;\n+  return price + tax;\n }\n`;

      const mockChat = vi.fn().mockResolvedValue({
        message: {
          role: 'assistant',
          content: JSON.stringify({
            diff: unifiedDiff,
            rationale: 'Changed subtraction operator (-) to addition operator (+) to correctly add tax to price.',
            updatedContent: fixedContent
          })
        }
      });

      const mockLlmClient = { chat: mockChat };

      const patch = await runFixer(ticket.id, {
        prisma,
        model: 'qwen3-coder:30b',
        llmClient: mockLlmClient
      });

      // 1. Verify Patch record fields
      expect(patch).toBeDefined();
      expect(patch.ticketId).toBe(ticket.id);
      expect(patch.status).toBe('awaiting_review');
      expect(patch.fixerModel).toBe('qwen3-coder:30b');
      expect(patch.rationale).toContain('addition operator');
      expect(patch.diff).toContain('+  return price + tax;');
      expect(patch.branchName).toContain(`fix/ticket-${ticket.id}`);

      // 2. Verify git branch exists in repo and contains the commit
      const rootGit = simpleGit(tempRepoPath);
      const branches = await rootGit.branchLocal();
      expect(branches.all).toContain(patch.branchName);

      const commitLog = await rootGit.log([patch.branchName, '-n', '1']);
      expect(commitLog.latest?.message).toContain('Incorrect tax calculation');

      // 3. Verify ticket status was updated to in_review
      const updatedTicket = await prisma.ticket.findUnique({
        where: { id: ticket.id }
      });
      expect(updatedTicket?.status).toBe('in_review');

      // 4. Verify LLM was called with correct model and prompt
      expect(mockChat).toHaveBeenCalledTimes(1);
    });

    it('runs against a fixture ticket with a missing null check bug and confirms the worktree file actually contains the fix', async () => {
      // 1. Buggy file with missing null check
      const buggyCode = `export function getUsername(user: { name?: string } | null): string {\n  return user.name || "Anonymous";\n}\n`;
      fs.writeFileSync(path.join(tempRepoPath, 'src/user.ts'), buggyCode, 'utf-8');
      const rootGit = simpleGit(tempRepoPath);
      await rootGit.add('src/user.ts');
      await rootGit.commit('Add buggy getUsername');

      const file = await prisma.file.create({
        data: {
          projectId: testProjectId,
          path: 'src/user.ts'
        }
      });

      const ticket = await prisma.ticket.create({
        data: {
          projectId: testProjectId,
          symptomFileId: file.id,
          rootCauseFileId: file.id,
          lineStart: 2,
          lineEnd: 2,
          title: 'Missing null check on user object in getUsername',
          description: 'getUsername will throw TypeError: Cannot read properties of null when user is null.',
          severity: Severity.high,
          confidence: 0.95,
          status: 'approved',
          scannerModel: 'qwen3:8b'
        }
      });

      const fixedCode = `export function getUsername(user: { name?: string } | null): string {\n  if (!user) return "Anonymous";\n  return user.name || "Anonymous";\n}\n`;
      const diff = `--- a/src/user.ts\n+++ b/src/user.ts\n@@ -1,3 +1,4 @@\n export function getUsername(user: { name?: string } | null): string {\n+  if (!user) return "Anonymous";\n   return user.name || "Anonymous";\n }\n`;

      const mockChat = vi.fn().mockResolvedValue({
        message: {
          role: 'assistant',
          content: JSON.stringify({
            diff,
            rationale: 'Added guard clause if (!user) return "Anonymous" to prevent null dereference.',
            updatedContent: fixedCode
          })
        }
      });

      // Run with cleanupWorktree: false so we can inspect the worktree file on disk directly
      const patch = await runFixer(ticket.id, {
        prisma,
        llmClient: { chat: mockChat },
        cleanupWorktree: false
      });

      // Verify Patch row was created
      expect(patch).toBeDefined();
      expect(patch.status).toBe('awaiting_review');
      expect(patch.ticketId).toBe(ticket.id);

      const worktreePath = (patch as any).worktreePath;
      expect(worktreePath).toBeDefined();
      expect(fs.existsSync(worktreePath)).toBe(true);

      // Confirm the worktree's file actually contains the fix
      const worktreeFileContent = fs.readFileSync(
        path.join(worktreePath, 'src/user.ts'),
        'utf-8'
      );
      expect(worktreeFileContent).toContain('if (!user) return "Anonymous";');
      expect(worktreeFileContent).toBe(fixedCode);

      // Clean up worktree directory
      await rootGit.raw(['worktree', 'remove', '--force', worktreePath]).catch(() => {});
      if (fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
    });
  });
});
