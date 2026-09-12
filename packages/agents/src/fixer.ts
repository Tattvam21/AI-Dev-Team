import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { applyPatch } from 'diff';
import { prisma as defaultPrisma, PrismaClient, Patch } from '@ai-dev-team/db';
import { generateStructured, loadPrompt } from '@ai-dev-team/llm-gateway';
import { createGitWorktree } from './git-worktree.js';

export const FixerPatchSchema = z.object({
  diff: z.string().describe('Unified diff format representation of the patch'),
  rationale: z.string().describe('Technical explanation of the fix and how it cures the defect'),
  updatedContent: z
    .string()
    .optional()
    .describe('Complete fixed content of the file (fallback if strict unified diff application fails)')
});

export type FixerPatchOutput = z.infer<typeof FixerPatchSchema>;

export interface RunFixerOptions {
  prisma?: PrismaClient;
  model?: string;
  llmClient?: any;
  promptVersion?: string;
  cleanupWorktree?: boolean;
  reviewerNotes?: string;
  extraContext?: string;
  timeoutMs?: number;
}

/**
 * Applies a patch to a file using the diff library, with a fallback to full updated content.
 * Choice rationale:
 * LLM-generated unified diffs often have minor offset errors in @@ -l,s +l,s @@ hunk headers.
 * If applyPatch succeeds, it provides precise surgical patching.
 * If applyPatch fails, writing the full updatedContent ensures reliable modification
 * without crashing or corrupting the file.
 */
export function applyPatchToFile(
  targetFilePath: string,
  originalContent: string,
  diffStr: string,
  updatedContent?: string
): { success: boolean; method: 'diff' | 'updatedContent' | 'failed' } {
  // 1. Try unified diff application
  if (diffStr && diffStr.trim() !== '') {
    try {
      const patched = applyPatch(originalContent, diffStr);
      if (typeof patched === 'string' && patched !== originalContent) {
        fs.writeFileSync(targetFilePath, patched, 'utf-8');
        return { success: true, method: 'diff' };
      }
    } catch {
      // Diff apply threw, continue to fallback
    }
  }

  // 2. Fallback to full updated content if provided
  if (updatedContent && updatedContent.trim() !== '') {
    fs.writeFileSync(targetFilePath, updatedContent, 'utf-8');
    return { success: true, method: 'updatedContent' };
  }

  return { success: false, method: 'failed' };
}

/**
 * Runs the Fixer Agent for an approved ticket:
 * 1. Creates an isolated git worktree for the fix branch.
 * 2. Builds a prompt from the 'fixer' template with file and ticket context.
 * 3. Calls generateStructured expecting { diff, rationale, updatedContent }.
 * 4. Applies the fix to the target file in the worktree.
 * 5. Commits the changes in the worktree.
 * 6. Saves a Patch row with status 'awaiting_review' and records fixerModel.
 */
export async function runFixer(
  ticketId: string,
  options: RunFixerOptions = {}
): Promise<Patch> {
  const prisma = options.prisma ?? defaultPrisma;
  const fixerModel =
    options.model ??
    process.env.FIXER_MODEL ??
    process.env.MODEL_FIXER ??
    'qwen3-coder:30b';

  // Fetch ticket details
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      project: true,
      symptomFile: true,
      rootCauseFile: true
    }
  });

  if (!ticket) {
    throw new Error(`Ticket with id '${ticketId}' not found`);
  }

  const projectRoot = path.resolve(ticket.project.localPath ?? process.cwd());

  // Determine target file to modify (prefer rootCauseFile, fallback to symptomFile)
  const targetRelPath =
    ticket.rootCauseFile?.path ?? ticket.symptomFile?.path;
  if (!targetRelPath) {
    throw new Error(`Ticket ${ticketId} has no associated file path to fix`);
  }

  // 1. Create an isolated git worktree on branch fix/ticket-<id>-<slug>
  const session = await createGitWorktree(projectRoot, ticket.id, {
    slug: ticket.title
  });

  try {
    const absTargetFilePath = path.join(session.worktreePath, targetRelPath);
    if (!fs.existsSync(absTargetFilePath)) {
      throw new Error(
        `Target file not found in worktree: ${absTargetFilePath} (relative: ${targetRelPath})`
      );
    }

    const fileContent = fs.readFileSync(absTargetFilePath, 'utf-8');

    // 2. Build prompt from the 'fixer' template
    let relatedContext = `Ticket Severity: ${ticket.severity} | Confidence: ${ticket.confidence} | Line Range: L${ticket.lineStart ?? 1}-L${ticket.lineEnd ?? 1}`;
    if (options.reviewerNotes) {
      relatedContext += `\nPrevious Reviewer Feedback (Fix was rejected): ${options.reviewerNotes}`;
    }
    if (options.extraContext) {
      relatedContext += `\nAdditional Context: ${options.extraContext}`;
    }

    const systemPrompt = loadPrompt('fixer', options.promptVersion ?? 'latest', {
      ticketTitle: ticket.title,
      ticketDescription: ticket.description,
      targetFile: targetRelPath,
      fileContent,
      relatedContext
    });

    let userPrompt = `Fix defect in file '${targetRelPath}': ${ticket.title}. ${ticket.description}`;
    if (options.reviewerNotes) {
      userPrompt += `\nIMPORTANT: A previous patch was rejected by the reviewer with the following feedback: "${options.reviewerNotes}". You must specifically address this critique in your new fix.`;
    }

    // 3. Call generateStructured
    const fixerTimeout =
      options.timeoutMs ??
      (process.env.FIXER_TIMEOUT_MS ? parseInt(process.env.FIXER_TIMEOUT_MS, 10) : 60000);

    const llmOutput = await generateStructured<FixerPatchOutput>({
      model: fixerModel,
      systemPrompt,
      userPrompt,
      schema: FixerPatchSchema,
      client: options.llmClient,
      promptVersion: options.promptVersion ?? 'fixer/v1',
      timeoutMs: fixerTimeout
    });

    // 4. Apply fix to the actual file in the worktree
    const applyResult = applyPatchToFile(
      absTargetFilePath,
      fileContent,
      llmOutput.diff,
      llmOutput.updatedContent
    );

    if (!applyResult.success) {
      throw new Error(
        `Failed to apply patch generated by ${fixerModel} to ${targetRelPath}`
      );
    }

    // 5. Commit change in the worktree with descriptive commit message
    await session.git.add(targetRelPath);
    const stagedDiff = await session.git.diff(['--cached']);

    const commitMessage = `fix(${path.basename(targetRelPath)}): ${ticket.title}\n\n${llmOutput.rationale}`;
    await session.git.commit(commitMessage);

    // 6. Save a Patch row with status 'awaiting_review' and fixerModel recorded
    const finalDiff = stagedDiff || llmOutput.diff;

    const patchRecord = await prisma.patch.create({
      data: {
        ticketId: ticket.id,
        branchName: session.branchName,
        diff: finalDiff,
        rationale: llmOutput.rationale,
        status: 'awaiting_review',
        fixerModel
      }
    });

    // Optionally update ticket status to 'in_review'
    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { status: 'in_review' }
    });

    Object.assign(patchRecord, { worktreePath: session.worktreePath });

    return patchRecord;
  } finally {
    // Clean up temporary worktree directory unless specifically requested to keep
    if (options.cleanupWorktree !== false) {
      await session.cleanup();
    }
  }
}
