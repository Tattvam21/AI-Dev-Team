import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { simpleGit } from 'simple-git';
import { prisma, Severity } from '@ai-dev-team/db';
import {
  pushAndCreatePullRequest,
  finalizeAndSync,
  parseGitHubRepo
} from './git-sync.js';

describe('Git-Sync Remote Path & GitHub Integration', () => {
  let bareRemotePath: string;
  let localRepoPath: string;
  let testProjectId: string;
  let testTicketId: string;
  let testPatchId: string;
  const branchName = 'fix/ticket-902-remote-fix';

  beforeAll(async () => {
    // 1. Create a bare git repository to act as our remote "origin"
    bareRemotePath = path.join(os.tmpdir(), `remote-bare-${Date.now()}.git`);
    fs.mkdirSync(bareRemotePath, { recursive: true });
    const bareGit = simpleGit(bareRemotePath);
    await bareGit.init(true, ['-b', 'main']);

    // 2. Create local working clone repository
    localRepoPath = path.join(os.tmpdir(), `local-worktree-${Date.now()}`);
    fs.mkdirSync(path.join(localRepoPath, 'src'), { recursive: true });

    const localGit = simpleGit(localRepoPath);
    await localGit.init(['-b', 'main']);
    await localGit.addConfig('user.name', 'Remote Sync Tester');
    await localGit.addConfig('user.email', 'tester@remote.dev');
    await localGit.addRemote('origin', bareRemotePath);

    // Initial commit on main
    fs.writeFileSync(
      path.join(localRepoPath, 'src/api.ts'),
      'export const config = { timeout: 1000, retries: 1 };\n'
    );
    await localGit.add('.');
    await localGit.commit('Initial main commit');
    await localGit.push('origin', 'main', ['--set-upstream']);

    // 3. Create fix branch and add Fixer + Test-Writer commits
    await localGit.checkoutLocalBranch(branchName);

    // Commit 1: Fixer
    fs.writeFileSync(
      path.join(localRepoPath, 'src/api.ts'),
      'export const config = { timeout: 5000, retries: 3 };\n'
    );
    await localGit.add('.');
    await localGit.commit('fix(api.ts): Increase timeout and retries for stability');

    // Commit 2: Test-Writer
    fs.writeFileSync(
      path.join(localRepoPath, 'src/api.test.ts'),
      'import { config } from "./api";\n\ntest("config updated", () => {\n  expect(config.timeout).toBe(5000);\n});\n'
    );
    await localGit.add('.');
    await localGit.commit('test: add regression test for config timeout');

    await localGit.checkout('main');

    // 4. Setup DB records with githubRepo configured
    const project = await prisma.project.create({
      data: {
        name: `remote-project-${Date.now()}`,
        localPath: localRepoPath,
        githubRepo: 'test-org/test-service'
      }
    });
    testProjectId = project.id;

    const file = await prisma.file.create({
      data: {
        projectId: testProjectId,
        path: 'src/api.ts'
      }
    });

    const ticket = await prisma.ticket.create({
      data: {
        projectId: testProjectId,
        symptomFileId: file.id,
        title: 'Increase default network timeouts',
        description: 'Requests are prematurely timing out under load.',
        severity: Severity.high,
        confidence: 0.92,
        status: 'awaiting_human',
        scannerModel: 'qwen3:8b'
      }
    });
    testTicketId = ticket.id;

    const patch = await prisma.patch.create({
      data: {
        ticketId: testTicketId,
        branchName,
        diff: '--- a/src/api.ts\n+++ b/src/api.ts\n@@ -1,1 +1,1 @@\n-export const config = { timeout: 1000, retries: 1 };\n+export const config = { timeout: 5000, retries: 3 };\n',
        rationale: 'Increased timeout to 5000ms and retries to 3.',
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
    if (bareRemotePath && fs.existsSync(bareRemotePath)) {
      await fs.promises.rm(bareRemotePath, { recursive: true, force: true }).catch(() => {});
    }
    if (localRepoPath && fs.existsSync(localRepoPath)) {
      await fs.promises.rm(localRepoPath, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe('parseGitHubRepo', () => {
    it('correctly parses various githubRepo formats', () => {
      expect(parseGitHubRepo('facebook/react')).toEqual({ owner: 'facebook', repo: 'react' });
      expect(parseGitHubRepo('https://github.com/nodejs/node')).toEqual({ owner: 'nodejs', repo: 'node' });
      expect(parseGitHubRepo('https://github.com/nodejs/node.git')).toEqual({ owner: 'nodejs', repo: 'node' });
      expect(parseGitHubRepo('git@github.com:torvalds/linux.git')).toEqual({ owner: 'torvalds', repo: 'linux' });
    });

    it('throws error for invalid format', () => {
      expect(() => parseGitHubRepo('invalid')).toThrow();
    });
  });

  describe('pushAndCreatePullRequest (Happy Path)', () => {
    it('rebases branch onto remote main, pushes to remote, and creates PR with Octokit', async () => {
      let prPayloadCaptured: any = null;

      const mockOctokit = {
        rest: {
          pulls: {
            create: vi.fn().mockImplementation(async (params: any) => {
              prPayloadCaptured = params;
              return {
                data: {
                  number: 101,
                  html_url: `https://github.com/${params.owner}/${params.repo}/pull/101`
                }
              };
            })
          }
        }
      };

      const mockLlmClient = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      title: 'fix: resolve issue',
                      body: 'This PR resolves the issue.'
                    })
                  }
                }
              ]
            })
          }
        }
      };

      const result = await pushAndCreatePullRequest(testPatchId, {
        prisma,
        projectPath: localRepoPath,
        octokitClient: mockOctokit,
        llmClient: mockLlmClient as any,
        baseBranch: 'main'
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('pushed');
      expect(result.prUrl).toBe('https://github.com/test-org/test-service/pull/101');
      expect(result.prNumber).toBe(101);
      expect(result.branchName).toBe(branchName);

      // Confirm Octokit was called with expected PR parameters
      expect(prPayloadCaptured).toBeDefined();
      expect(prPayloadCaptured.owner).toBe('test-org');
      expect(prPayloadCaptured.repo).toBe('test-service');
      expect(prPayloadCaptured.head).toBe(branchName);
      expect(prPayloadCaptured.base).toBe('main');
      expect(prPayloadCaptured.title).toBeDefined();
      expect(prPayloadCaptured.body).toBeDefined();

      // Confirm Patch in DB has status 'pushed' and prUrl stored
      const updatedPatch = await prisma.patch.findUnique({
        where: { id: testPatchId }
      });
      expect(updatedPatch?.status).toBe('pushed');
      expect(updatedPatch?.prUrl).toBe('https://github.com/test-org/test-service/pull/101');

      // Confirm Ticket in DB has status 'pushed'
      const updatedTicket = await prisma.ticket.findUnique({
        where: { id: testTicketId }
      });
      expect(updatedTicket?.status).toBe('pushed');

      // Confirm AuditLog was recorded
      const auditLog = await prisma.auditLog.findFirst({
        where: {
          ticketId: testTicketId,
          action: 'pr_created'
        }
      });
      expect(auditLog).toBeDefined();
      expect((auditLog?.details as any)?.prNumber).toBe(101);
    }, 15000);
  });

  describe('pushAndCreatePullRequest (Conflict Scenario)', () => {
    it('detects rebase conflict against remote main, sets failed_conflict, and does not force push', async () => {
      // 1. Create a second ticket and branch that will conflict
      const conflictBranch = 'fix/ticket-conflict-scenario';
      const localGit = simpleGit(localRepoPath);

      await localGit.checkout('main');
      await localGit.checkoutLocalBranch(conflictBranch);

      // Fixer commit on conflict branch
      fs.writeFileSync(
        path.join(localRepoPath, 'src/api.ts'),
        'export const config = { timeout: 99999, conflict: true };\n'
      );
      await localGit.add('.');
      await localGit.commit('fix(api.ts): Conflicting change on branch');

      // Test-Writer commit
      fs.writeFileSync(
        path.join(localRepoPath, 'src/api.test.ts'),
        'test("conflict", () => {});\n'
      );
      await localGit.add('.');
      await localGit.commit('test: add test for conflict');

      // 2. Meanwhile, someone pushes a conflicting commit directly to remote main!
      await localGit.checkout('main');
      fs.writeFileSync(
        path.join(localRepoPath, 'src/api.ts'),
        'export const config = { timeout: 77777, upstreamChanged: true };\n'
      );
      await localGit.add('.');
      await localGit.commit('chore(main): Upstream conflicting edit on main');
      await localGit.push('origin', 'main');

      // Reset local main to before the push to simulate remote having advanced ahead
      await localGit.checkout(conflictBranch);

      // Create Patch row in DB
      const conflictPatch = await prisma.patch.create({
        data: {
          ticketId: testTicketId,
          branchName: conflictBranch,
          diff: 'some conflicting diff',
          status: 'approved',
          fixerModel: 'qwen3-coder:30b'
        }
      });

      const mockOctokit = {
        rest: {
          pulls: {
            create: vi.fn()
          }
        }
      };

      const result = await pushAndCreatePullRequest(conflictPatch.id, {
        prisma,
        projectPath: localRepoPath,
        octokitClient: mockOctokit,
        baseBranch: 'main'
      });

      // Confirm result reports conflict
      expect(result.success).toBe(false);
      expect(result.status).toBe('failed_conflict');
      expect(result.error).toContain('Rebase conflict');

      // Confirm Octokit was NEVER called to create a PR
      expect(mockOctokit.rest.pulls.create).not.toHaveBeenCalled();

      // Confirm Patch status in DB was set to 'failed_conflict'
      const dbPatch = await prisma.patch.findUnique({
        where: { id: conflictPatch.id }
      });
      expect(dbPatch?.status).toBe('failed_conflict');

      // Confirm rebase was aborted and git status is clean (not stuck in rebase)
      const status = await localGit.status();
      expect(status.isClean()).toBe(true);

      // Confirm AuditLog recorded rebase_conflict
      const conflictAudit = await prisma.auditLog.findFirst({
        where: {
          ticketId: testTicketId,
          action: 'rebase_conflict'
        }
      });
      expect(conflictAudit).toBeDefined();

      // Cleanup
      await prisma.patch.delete({ where: { id: conflictPatch.id } });
      await localGit.checkout('main');
    });
  });

  describe('finalizeAndSync Router', () => {
    it('routes local-only project to local finalization without attempting remote push', async () => {
      const localProject = await prisma.project.create({
        data: {
          name: `local-only-router-${Date.now()}`,
          localPath: localRepoPath,
          githubRepo: null
        }
      });

      const localTicket = await prisma.ticket.create({
        data: {
          projectId: localProject.id,
          symptomFileId: (await prisma.file.findFirst({ where: { projectId: testProjectId } }))!.id,
          title: 'Local task',
          description: 'Local task description',
          severity: Severity.low,
          confidence: 0.8,
          status: 'awaiting_human',
          scannerModel: 'qwen3:8b'
        }
      });

      const localPatch = await prisma.patch.create({
        data: {
          ticketId: localTicket.id,
          branchName,
          diff: 'diff content',
          status: 'approved',
          fixerModel: 'qwen3-coder:30b'
        }
      });

      const syncResult = await finalizeAndSync(localPatch.id, {
        prisma,
        projectPath: localRepoPath,
        baseBranch: 'main'
      });

      expect(syncResult.status).toBe('ready_to_push');
      expect((syncResult as any).isLocalOnly).toBe(true);
      expect((syncResult as any).manualApplyInstructions).toBeDefined();

      // Cleanup
      await prisma.project.delete({ where: { id: localProject.id } });
    });
  });
});
