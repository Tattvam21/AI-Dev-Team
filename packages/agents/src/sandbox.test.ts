import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { simpleGit } from 'simple-git';
import { prisma, Severity } from '@ai-dev-team/db';
import { runTests, detectEnvironment, executeInSandbox } from './sandbox.js';

describe('Sandbox Test Execution Module', () => {
  let tempRepoPath: string;
  let testProjectId: string;
  let testPatchId: string;

  beforeAll(async () => {
    // 1. Create a git repo fixture with a passing test suite
    tempRepoPath = path.join(os.tmpdir(), `sandbox-fixture-${Date.now()}`);
    fs.mkdirSync(tempRepoPath, { recursive: true });

    const git = simpleGit(tempRepoPath);
    await git.init(['-b', 'main']);
    await git.addConfig('user.name', 'Sandbox Test');
    await git.addConfig('user.email', 'sandbox@test.local');

    // package.json with test script
    const packageJson = {
      name: 'sandbox-fixture',
      version: '1.0.0',
      type: 'commonjs',
      scripts: {
        test: 'node test.js'
      }
    };
    fs.writeFileSync(
      path.join(tempRepoPath, 'package.json'),
      JSON.stringify(packageJson, null, 2),
      'utf-8'
    );

    // Implementation file
    fs.writeFileSync(
      path.join(tempRepoPath, 'math.js'),
      'function add(a, b) { return a + b; }\nmodule.exports = { add };\n',
      'utf-8'
    );

    // Passing test file
    fs.writeFileSync(
      path.join(tempRepoPath, 'test.js'),
      'const assert = require("assert");\nconst { add } = require("./math");\nassert.strictEqual(add(2, 3), 5);\nconsole.log("UNIT_TESTS_PASSED_SUCCESSFULLY");\n',
      'utf-8'
    );

    await git.add('.');
    await git.commit('Initial testable fixture commit');

    // Create fix branch
    await git.checkoutLocalBranch('fix/ticket-demo-sandbox');
    fs.writeFileSync(
      path.join(tempRepoPath, 'math.js'),
      'function add(a, b) { return a + b; }\nmodule.exports = { add };\n// patched\n',
      'utf-8'
    );
    await git.add('math.js');
    await git.commit('Apply patch to math.js');
    await git.checkout('main');

    // 2. Setup project, file, ticket, and patch in DB
    const project = await prisma.project.create({
      data: {
        name: `sandbox-project-${Date.now()}`,
        localPath: tempRepoPath
      }
    });
    testProjectId = project.id;

    const file = await prisma.file.create({
      data: {
        projectId: testProjectId,
        path: 'math.js'
      }
    });

    const ticket = await prisma.ticket.create({
      data: {
        projectId: testProjectId,
        symptomFileId: file.id,
        title: 'Fix addition logic',
        description: 'Ensure add works',
        severity: Severity.medium,
        confidence: 0.95,
        status: 'in_review',
        scannerModel: 'qwen3:8b'
      }
    });

    const patch = await prisma.patch.create({
      data: {
        ticketId: ticket.id,
        branchName: 'fix/ticket-demo-sandbox',
        diff: '--- a/math.js\n+++ b/math.js\n@@ -1,2 +1,3 @@\n+ // patched',
        rationale: 'Fix math',
        status: 'awaiting_review',
        fixerModel: 'qwen3-coder:30b'
      }
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

  describe('detectEnvironment', () => {
    it('detects Node environment when package.json is present', () => {
      const env = detectEnvironment(tempRepoPath);
      expect(env.image).toBe('node:20-alpine');
      expect(env.defaultCommand).toBe('npm test');
    });

    it('detects Python environment when requirements.txt is present', () => {
      const pythonDir = path.join(os.tmpdir(), `py-detect-${Date.now()}`);
      fs.mkdirSync(pythonDir, { recursive: true });
      fs.writeFileSync(path.join(pythonDir, 'requirements.txt'), 'pytest\n');

      try {
        const env = detectEnvironment(pythonDir);
        expect(env.image).toBe('python:3.11-alpine');
        expect(env.defaultCommand).toBe('pytest');
      } finally {
        fs.rmSync(pythonDir, { recursive: true, force: true });
      }
    });
  });

  describe('executeInSandbox & network isolation', () => {
    it('fails when a test attempts network access due to --network none', async () => {
      const netTestDir = path.join(os.tmpdir(), `net-test-${Date.now()}`);
      fs.mkdirSync(netTestDir, { recursive: true });

      // Script that tries to fetch an external IP address
      const fetchScript = `
        fetch("http://1.1.1.1")
          .then(() => { console.log("NETWORK_CONNECTED"); process.exit(0); })
          .catch((err) => { console.error("NETWORK_BLOCKED:", err.cause?.code || err.message); process.exit(1); });
      `;
      fs.writeFileSync(path.join(netTestDir, 'net.js'), fetchScript, 'utf-8');

      try {
        const result = await executeInSandbox(netTestDir, 'node net.js');
        expect(result.passed).toBe(false);
        expect(result.exitCode).not.toBe(0);
        expect(result.logs).toContain('NETWORK_BLOCKED: ENETUNREACH');
      } finally {
        fs.rmSync(netTestDir, { recursive: true, force: true });
      }
    }, 15000);
  });

  describe('runTests', () => {
    it('runs project test suite in Docker container and records a passing TestRun row in Prisma', async () => {
      const testRun = await runTests(testPatchId);

      expect(testRun).toBeDefined();
      expect(testRun.patchId).toBe(testPatchId);
      expect(testRun.passed).toBe(true);
      expect(testRun.logs).toContain('UNIT_TESTS_PASSED_SUCCESSFULLY');
      expect(testRun.durationMs).toBeGreaterThan(0);

      // Verify row in DB
      const dbRow = await prisma.testRun.findUnique({
        where: { id: testRun.id }
      });
      expect(dbRow).not.toBeNull();
      expect(dbRow?.passed).toBe(true);
    }, 20000);

    it('records failing TestRun row when tests fail', async () => {
      // Run with failing command
      const failingTestRun = await runTests(testPatchId, {
        testCommand: 'node -e "console.error(\'AssertionFailed: expected 5 to be 99\'); process.exit(1);"'
      });

      expect(failingTestRun).toBeDefined();
      expect(failingTestRun.passed).toBe(false);
      expect(failingTestRun.logs).toContain('AssertionFailed');

      const dbRow = await prisma.testRun.findUnique({
        where: { id: failingTestRun.id }
      });
      expect(dbRow?.passed).toBe(false);
    }, 20000);
  });
});
