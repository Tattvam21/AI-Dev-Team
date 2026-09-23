import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { prisma as defaultPrisma, type PrismaClient, type TestRun } from '@ai-dev-team/db';
import { createGitWorktree } from './git-worktree.ts';

export interface SandboxEnvironment {
  image: string;
  defaultCommand: string;
}

export interface RunTestsOptions {
  prisma?: PrismaClient;
  testCommand?: string;
  image?: string;
  timeoutSec?: number; // default 120s
  memoryLimit?: string; // default '1g'
  worktreePath?: string;
}

export interface SandboxExecutionResult {
  passed: boolean;
  logs: string;
  durationMs: number;
  exitCode: number | null;
}

/**
 * Detects the runtime environment and appropriate Docker image from project files.
 */
export function detectEnvironment(worktreePath: string): SandboxEnvironment {
  const hasPackageJson = fs.existsSync(path.join(worktreePath, 'package.json'));
  if (hasPackageJson) {
    return {
      image: 'node:20-alpine',
      defaultCommand: 'npm test'
    };
  }

  const hasPython =
    fs.existsSync(path.join(worktreePath, 'requirements.txt')) ||
    fs.existsSync(path.join(worktreePath, 'pyproject.toml')) ||
    fs.existsSync(path.join(worktreePath, 'setup.py'));

  if (hasPython) {
    return {
      image: 'python:3.11-alpine',
      defaultCommand: 'pytest'
    };
  }

  // Default fallback to node:20-alpine
  return {
    image: 'node:20-alpine',
    defaultCommand: 'npm test'
  };
}

/**
 * Runs a command inside a sandboxed Docker container with:
 * - Read-write mount of the worktree
 * - No network access (--network none)
 * - Memory limit (default 1GB)
 * - Timeout enforcement (default 120s)
 * - Captures stdout, stderr, exit code, and duration
 */
export async function executeInSandbox(
  worktreePath: string,
  command: string,
  options: {
    image?: string;
    memoryLimit?: string;
    timeoutSec?: number;
  } = {}
): Promise<SandboxExecutionResult> {
  const env = detectEnvironment(worktreePath);
  const image = options.image || env.image;
  const memoryLimit = options.memoryLimit || '1g';
  const timeoutSec = options.timeoutSec ?? 120;
  const timeoutMs = timeoutSec * 1000;

  const resolvedWorktree = path.resolve(worktreePath);

  const dockerArgs = [
    'run',
    '--rm',
    '--network',
    'none',
    '--memory',
    memoryLimit,
    '-v',
    `${resolvedWorktree}:/workspace:rw`,
    '-w',
    '/workspace',
    '--entrypoint',
    'sh',
    image,
    '-c',
    command
  ];

  const startTime = Date.now();
  let logs = '';
  let timedOut = false;

  return new Promise((resolve) => {
    const child = spawn('docker', dockerArgs);

    let timeoutTimer: NodeJS.Timeout | null = setTimeout(() => {
      timedOut = true;
      logs += `\n[Sandbox Error] Execution timed out after ${timeoutSec} seconds.\n`;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (data: Buffer) => {
      logs += data.toString('utf-8');
    });

    child.stderr.on('data', (data: Buffer) => {
      logs += data.toString('utf-8');
    });

    child.on('error', (err: Error) => {
      logs += `\n[Docker Spawn Error]: ${err.message}\n`;
    });

    child.on('close', (code: number | null) => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      const durationMs = Date.now() - startTime;
      const passed = code === 0 && !timedOut;
      resolve({
        passed,
        logs: logs.trim(),
        durationMs,
        exitCode: code
      });
    });
  });
}

/**
 * Runs tests for a given Patch ID:
 * 1. Resolves patch, branch, and project path.
 * 2. Checks out worktree on the patch branch (or uses provided worktreePath).
 * 3. Detects environment and runs the test command inside the isolated Docker sandbox.
 * 4. Records a TestRun row linked to the Patch in Prisma.
 * 5. Cleans up the worktree if created.
 */
export async function runTests(
  patchId: string,
  options: RunTestsOptions = {}
): Promise<TestRun> {
  const prisma = options.prisma ?? defaultPrisma;

  const patch = await prisma.patch.findUnique({
    where: { id: patchId },
    include: {
      ticket: {
        include: {
          project: true
        }
      }
    }
  });

  if (!patch) {
    throw new Error(`Patch with id '${patchId}' not found`);
  }

  let worktreePath = options.worktreePath;
  let sessionToCleanup: { cleanup: () => Promise<void> } | null = null;

  if (!worktreePath) {
    const projectRoot = path.resolve(patch.ticket.project.localPath ?? process.cwd());
    const session = await createGitWorktree(projectRoot, patch.ticket.id, {
      slug: patch.ticket.title
    });
    worktreePath = session.worktreePath;
    sessionToCleanup = session;
  }

  try {
    const env = detectEnvironment(worktreePath);
    const command = options.testCommand || env.defaultCommand;

    const result = await executeInSandbox(worktreePath, command, {
      image: options.image || env.image,
      memoryLimit: options.memoryLimit,
      timeoutSec: options.timeoutSec
    });

    // Write TestRun row linked to patch
    const testRun = await prisma.testRun.create({
      data: {
        patchId: patch.id,
        passed: result.passed,
        logs: result.logs,
        durationMs: result.durationMs,
        ranAt: new Date()
      }
    });

    return testRun;
  } finally {
    if (sessionToCleanup) {
      await sessionToCleanup.cleanup();
    }
  }
}
