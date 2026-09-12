import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { prisma as defaultPrisma, PrismaClient } from '@ai-dev-team/db';
import { generateStructured, loadPrompt } from '@ai-dev-team/llm-gateway';
import { createGitWorktree } from './git-worktree.js';

export const TestWriterOutputSchema = z.object({
  testFilePath: z.string().describe('Relative path to the test file (e.g. src/calculator.test.ts)'),
  testFileContent: z.string().describe('Full content of the test file')
});

export type TestWriterOutput = z.infer<typeof TestWriterOutputSchema>;

export interface RunTestWriterOptions {
  prisma?: PrismaClient;
  model?: string;
  llmClient?: any;
  promptVersion?: string;
  worktreePath?: string;
  cleanupWorktree?: boolean;
  timeoutMs?: number;
}

/**
 * Searches for existing test files in the worktree to provide context to the LLM.
 */
function findExistingTestContext(worktreePath: string): string {
  try {
    const candidates: string[] = [];
    function scan(dir: string, depth = 0) {
      if (depth > 4) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full, depth + 1);
        } else if (/\.(test|spec)\.[jt]sx?$/.test(entry.name)) {
          candidates.push(path.relative(worktreePath, full));
        }
      }
    }
    scan(worktreePath);

    if (candidates.length === 0) {
      return 'No existing test files found. Use standard Node assert or test runner framework.';
    }

    const firstTestPath = path.join(worktreePath, candidates[0]);
    const snippet = fs.readFileSync(firstTestPath, 'utf-8').slice(0, 800);
    return `Existing test convention (${candidates[0]}):\n${snippet}`;
  } catch {
    return 'Standard testing conventions.';
  }
}

/**
 * Runs the Test-Writer Agent for a given Patch:
 * 1. Attaches or reuses an isolated git worktree for the patch branch.
 * 2. Compiles a prompt from the 'test-writer' template with diff and rationale.
 * 3. Calls generateStructured expecting { testFilePath, testFileContent }.
 * 4. Writes the test file into the worktree.
 * 5. Commits the new test as a follow-up commit on the same branch.
 */
export async function runTestWriter(
  patchId: string,
  options: RunTestWriterOptions = {}
): Promise<void> {
  const prisma = options.prisma ?? defaultPrisma;
  const testWriterModel =
    options.model ??
    process.env.TESTWRITER_MODEL ??
    process.env.SCANNER_MODEL ??
    'llama3:latest';

  // Fetch patch, ticket, and project
  const patch = await prisma.patch.findUnique({
    where: { id: patchId },
    include: {
      ticket: {
        include: {
          project: true,
          symptomFile: true,
          rootCauseFile: true
        }
      }
    }
  });

  if (!patch) {
    throw new Error(`Patch with id '${patchId}' not found`);
  }

  const projectRoot = path.resolve(patch.ticket.project.localPath ?? process.cwd());

  let worktreePath = options.worktreePath;
  let sessionToCleanup: { cleanup: () => Promise<void> } | null = null;
  let gitInstance: any = null;

  if (!worktreePath) {
    const session = await createGitWorktree(projectRoot, patch.ticket.id, {
      slug: patch.ticket.title
    });
    worktreePath = session.worktreePath;
    sessionToCleanup = session;
    gitInstance = session.git;
  } else {
    const { simpleGit } = await import('simple-git');
    gitInstance = simpleGit(worktreePath);
  }

  try {
    const existingTestContext = findExistingTestContext(worktreePath);

    // 1. Build prompt from 'test-writer' template
    const ticketDescription = `Title: ${patch.ticket.title}\nDescription: ${patch.ticket.description}\nFix Rationale: ${patch.rationale || 'Bug fix patch applied.'}`;

    const systemPrompt = loadPrompt('test-writer', options.promptVersion ?? 'latest', {
      ticketDescription,
      diff: patch.diff,
      existingTests: existingTestContext
    });

    const userPrompt = `Write regression tests verifying the patch fix. Return testFilePath and testFileContent.`;

    // 2. Call generateStructured
    const testWriterTimeout =
      options.timeoutMs ??
      (process.env.TESTWRITER_TIMEOUT_MS ? parseInt(process.env.TESTWRITER_TIMEOUT_MS, 10) : 60000);

    const llmOutput = await generateStructured<TestWriterOutput>({
      model: testWriterModel,
      systemPrompt,
      userPrompt,
      schema: TestWriterOutputSchema,
      client: options.llmClient,
      promptVersion: options.promptVersion ?? 'test-writer/v1',
      timeoutMs: testWriterTimeout
    });

    // 3. Write test file into worktree
    const cleanRelPath = llmOutput.testFilePath.replace(/^[/\\]+/, '');
    const absTestFilePath = path.join(worktreePath, cleanRelPath);

    fs.mkdirSync(path.dirname(absTestFilePath), { recursive: true });
    fs.writeFileSync(absTestFilePath, llmOutput.testFileContent, 'utf-8');

    // 4. Commit as follow-up commit on the same branch
    await gitInstance.add(cleanRelPath);
    const commitMessage = `test: add regression tests for ${patch.ticket.title}`;
    await gitInstance.commit(commitMessage);
  } finally {
    if (sessionToCleanup && options.cleanupWorktree !== false) {
      await sessionToCleanup.cleanup();
    }
  }
}
