import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { simpleGit } from 'simple-git';
import { FastifyInstance } from 'fastify';
import { prisma, Severity } from '@ai-dev-team/db';
import { buildApp } from './app.js';
import { closeQueues } from './queue.js';

describe('Git-Sync Local Finalization API Integration', () => {
  let app: FastifyInstance;
  let tempRepoPath: string;
  let testProjectId: string;
  let testTicketId: string;
  let testPatchId: string;
  const branchName = 'fix/ticket-fixture-manual-apply';

  beforeAll(async () => {
    app = buildApp({ logger: false });
    await app.ready();

    // 1. Create a git repo fixture
    tempRepoPath = path.join(os.tmpdir(), `api-git-sync-${Date.now()}`);
    fs.mkdirSync(path.join(tempRepoPath, 'src'), { recursive: true });

    const git = simpleGit(tempRepoPath);
    await git.init(['-b', 'main']);
    await git.addConfig('user.name', 'API Tester');
    await git.addConfig('user.email', 'apitester@local.dev');

    // Base commit on main
    fs.writeFileSync(
      path.join(tempRepoPath, 'src/service.ts'),
      'export function multiply(a: number, b: number): number {\n  return a + b;\n}\n'
    );
    await git.add('.');
    await git.commit('Initial service commit');

    // 2. Setup project with NO githubRepo (local-only manual apply)
    const project = await prisma.project.create({
      data: {
        name: `local-sync-proj-${Date.now()}`,
        localPath: tempRepoPath,
        githubRepo: null
      }
    });
    testProjectId = project.id;

    const file = await prisma.file.create({
      data: {
        projectId: testProjectId,
        path: 'src/service.ts'
      }
    });

    const ticket = await prisma.ticket.create({
      data: {
        projectId: testProjectId,
        symptomFileId: file.id,
        title: 'Fix incorrect multiplication logic',
        description: 'multiply function adds instead of multiplying',
        severity: Severity.high,
        confidence: 0.9,
        status: 'awaiting_human',
        scannerModel: 'qwen3:8b'
      }
    });
    testTicketId = ticket.id;

    // Create the fix branch with both Fixer and Test-Writer commits
    await git.checkoutLocalBranch(branchName);

    // 1st commit: Fixer
    fs.writeFileSync(
      path.join(tempRepoPath, 'src/service.ts'),
      'export function multiply(a: number, b: number): number {\n  return a * b;\n}\n'
    );
    await git.add('.');
    await git.commit('fix(service.ts): Fix incorrect multiplication logic');

    // 2nd commit: Test-Writer
    fs.writeFileSync(
      path.join(tempRepoPath, 'src/service.test.ts'),
      'import { multiply } from "./service";\n\ntest("multiplies correctly", () => {\n  expect(multiply(2, 3)).toBe(6);\n});\n'
    );
    await git.add('.');
    await git.commit('test: add regression tests for Fix incorrect multiplication logic');

    await git.checkout('main');

    // Create Patch in DB with status 'approved'
    const patch = await prisma.patch.create({
      data: {
        ticketId: testTicketId,
        branchName,
        diff: '--- a/src/service.ts\n+++ b/src/service.ts\n@@ -2,1 +2,1 @@\n-  return a + b;\n+  return a * b;\n',
        rationale: 'Changed addition to multiplication.',
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
    await app.close();
    await closeQueues();
    await prisma.$disconnect();
  });

  it('finalizes local patch commits via POST /patches/:id/finalize-local', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/patches/${testPatchId}/finalize-local`,
      payload: {
        baseBranch: 'main'
      }
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body.success).toBe(true);
    expect(body.patch.status).toBe('ready_to_push');
    expect(body.patch.isLocalOnly).toBe(true);
    expect(body.patch.branchName).toBe(branchName);
    expect(body.patch.commitCount).toBe(2);
    expect(body.patch.manualApplyInstructions).toContain('git merge');
  });

  it('retrieves the diff and manual instructions via GET /patches/:id/diff', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/patches/${testPatchId}/diff`
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body.patchId).toBe(testPatchId);
    expect(body.status).toBe('ready_to_push');
    expect(body.isLocalOnly).toBe(true);
    expect(body.diff).toContain('export function multiply');
    expect(body.diff).toContain('multiplies correctly');
    expect(body.manualApplyInstructions).toContain('git merge fix/ticket-fixture-manual-apply');
  });

  it('retrieves plain text diff when Accept: text/plain is requested', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/patches/${testPatchId}/diff`,
      headers: {
        Accept: 'text/plain'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('diff --git');
    expect(response.body).toContain('service.ts');
  });

  it('confirms the patch status is ready_to_push and diff is retrievable via GET /tickets/:id/patch', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/tickets/${testTicketId}/patch`
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body.id).toBe(testPatchId);
    expect(body.status).toBe('ready_to_push');
    expect(body.diff).toBeDefined();
  });
});
