import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { simpleGit } from 'simple-git';
import { prisma, Severity } from '@ai-dev-team/db';
import {
  verifyBranchCommits,
  finalizeLocalCommits,
  exportPatchDiff,
  generateManualApplyInstructions
} from './git-sync.js';

describe('Git-Sync Local Path', () => {
  let tempRepoPath: string;
  let testProjectId: string;
  let testTicketId: string;
  let testPatchId: string;
  const branchName = 'fix/ticket-901-test-fix';

  beforeAll(async () => {
    // 1. Create a git repo fixture
    tempRepoPath = path.join(os.tmpdir(), `git-sync-fixture-${Date.now()}`);
    fs.mkdirSync(path.join(tempRepoPath, 'src'), { recursive: true });

    const git = simpleGit(tempRepoPath);
    await git.init(['-b', 'main']);
    await git.addConfig('user.name', 'Git Sync Tester');
    await git.addConfig('user.email', 'gitsync@test.local');

    // Create initial main branch commit
    fs.writeFileSync(
      path.join(tempRepoPath, 'src/math.ts'),
      'export function add(a: number, b: number): number {\n  return a - b;\n}\n'
    );
    await git.add('.');
    await git.commit('Initial repository commit');

    // 2. Setup project in DB WITHOUT githubRepo (local-only project)
    const project = await prisma.project.create({
      data: {
        name: `git-sync-local-${Date.now()}`,
        localPath: tempRepoPath,
        githubRepo: null
      }
    });
    testProjectId = project.id;

    const file = await prisma.file.create({
      data: {
        projectId: testProjectId,
        path: 'src/math.ts'
      }
    });

    const ticket = await prisma.ticket.create({
      data: {
        projectId: testProjectId,
        symptomFileId: file.id,
        title: 'Fix addition operator in math.ts',
        description: 'add function subtracts instead of adding',
        severity: Severity.high,
        confidence: 0.95,
        status: 'awaiting_human',
        scannerModel: 'qwen3:8b'
      }
    });
    testTicketId = ticket.id;

    const patch = await prisma.patch.create({
      data: {
        ticketId: testTicketId,
        branchName,
        diff: '--- a/src/math.ts\n+++ b/src/math.ts\n@@ -2,1 +2,1 @@\n-  return a - b;\n+  return a + b;\n',
        rationale: 'Replaced subtraction operator with addition.',
        status: 'approved',
        fixerModel: 'qwen3-coder:30b'
      }
    });
    testPatchId = patch.id;
  });

  afterAll(async () => {
    if (testProjectId) {
      await prisma.project.delete({
        where: { id: testProjectId }
      }).catch(() => {});
    }
    if (tempRepoPath && fs.existsSync(tempRepoPath)) {
      await fs.promises.rm(tempRepoPath, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe('verifyBranchCommits', () => {
    it('fails when branch does not exist or has no commits relative to main', async () => {
      const git = simpleGit(tempRepoPath);
      await git.checkoutLocalBranch('incomplete-branch');

      const result = await verifyBranchCommits(tempRepoPath, 'incomplete-branch', 'main');
      expect(result.valid).toBe(false);

      await git.checkout('main');
    });

    it('fails when branch only has Fixer commit (missing Test-Writer commit)', async () => {
      const git = simpleGit(tempRepoPath);
      await git.checkoutLocalBranch('only-fix-branch');

      fs.writeFileSync(
        path.join(tempRepoPath, 'src/math.ts'),
        'export function add(a: number, b: number): number {\n  return a + b;\n}\n'
      );
      await git.add('.');
      await git.commit('fix(math.ts): Fix addition operator in math.ts');

      const result = await verifyBranchCommits(tempRepoPath, 'only-fix-branch', 'main');
      expect(result.valid).toBe(false);
      expect(result.hasFixCommit).toBe(true);
      expect(result.hasTestCommit).toBe(false);
      expect(result.reason).toContain('missing a Test-Writer commit');

      await git.checkout('main');
    });

    it('succeeds when branch has both Fixer and Test-Writer commits', async () => {
      const git = simpleGit(tempRepoPath);
      await git.checkoutLocalBranch(branchName);

      // 1. Fixer commit
      fs.writeFileSync(
        path.join(tempRepoPath, 'src/math.ts'),
        'export function add(a: number, b: number): number {\n  return a + b;\n}\n'
      );
      await git.add('.');
      await git.commit('fix(math.ts): Fix addition operator in math.ts');

      // 2. Test-Writer commit
      fs.writeFileSync(
        path.join(tempRepoPath, 'src/math.test.ts'),
        'import { add } from "./math";\n\ntest("add works", () => {\n  expect(add(1, 2)).toBe(3);\n});\n'
      );
      await git.add('.');
      await git.commit('test: add regression tests for Fix addition operator in math.ts');

      const result = await verifyBranchCommits(tempRepoPath, branchName, 'main');
      expect(result.valid).toBe(true);
      expect(result.hasFixCommit).toBe(true);
      expect(result.hasTestCommit).toBe(true);
      expect(result.commits.length).toBe(2);

      await git.checkout('main');
    });
  });

  describe('finalizeLocalCommits', () => {
    it('rejects unapproved patches', async () => {
      const unapprovedPatch = await prisma.patch.create({
        data: {
          ticketId: testTicketId,
          branchName,
          diff: 'some-diff',
          status: 'awaiting_review',
          fixerModel: 'qwen3-coder:30b'
        }
      });

      await expect(
        finalizeLocalCommits(unapprovedPatch.id, { prisma, projectPath: tempRepoPath })
      ).rejects.toThrow(/must be 'approved'/);

      await prisma.patch.delete({ where: { id: unapprovedPatch.id } });
    });

    it('finalizes approved patch to ready_to_push on local-only project', async () => {
      const syncResult = await finalizeLocalCommits(testPatchId, {
        prisma,
        projectPath: tempRepoPath,
        baseBranch: 'main'
      });

      expect(syncResult.status).toBe('ready_to_push');
      expect(syncResult.isLocalOnly).toBe(true);
      expect(syncResult.branchName).toBe(branchName);
      expect(syncResult.commitCount).toBe(2);
      expect(syncResult.diff).toContain('export function add');
      expect(syncResult.diff).toContain('add works');
      expect(syncResult.manualApplyInstructions).toBeDefined();
      expect(syncResult.manualApplyInstructions).toContain('git merge fix/ticket-901-test-fix');

      // Verify DB patch status was updated to ready_to_push
      const updatedPatch = await prisma.patch.findUnique({
        where: { id: testPatchId }
      });
      expect(updatedPatch?.status).toBe('ready_to_push');

      // Verify AuditLog was recorded
      const auditLog = await prisma.auditLog.findFirst({
        where: {
          ticketId: testTicketId,
          action: 'patch_ready_to_push'
        }
      });
      expect(auditLog).toBeDefined();
      expect((auditLog?.details as any)?.isLocalOnly).toBe(true);
    });
  });

  describe('exportPatchDiff', () => {
    it('exports combined unified diff for the patch from git branch', async () => {
      const diff = await exportPatchDiff(testPatchId, {
        prisma,
        projectPath: tempRepoPath,
        baseBranch: 'main'
      });

      expect(diff).toContain('src/math.ts');
      expect(diff).toContain('src/math.test.ts');
    });
  });

  describe('generateManualApplyInstructions', () => {
    it('produces formatted instructions with git commands', () => {
      const instructions = generateManualApplyInstructions('fix/ticket-123', 'fake diff');
      expect(instructions).toContain('git merge fix/ticket-123');
      expect(instructions).toContain('git apply');
      expect(instructions).toContain('fake diff');
    });
  });
});
