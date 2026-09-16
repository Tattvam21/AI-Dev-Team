import { z } from 'zod';
import { prisma as defaultPrisma, PrismaClient, Review, ReviewVerdict } from '@ai-dev-team/db';
import { generateStructured, loadPrompt } from '@ai-dev-team/llm-gateway';

export const ReviewerOutputSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'disputed']).describe(
    "Verdict: 'pass' if the patch accurately and safely fixes the problem, 'fail' otherwise, or 'disputed' if council verdict is split"
  ),
  notes: z.string().describe(
    "Detailed review notes restating the original problem and evaluating whether the diff specifically resolves that exact root cause"
  )
});

export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>;

export interface RunReviewerOptions {
  prisma?: PrismaClient;
  model?: string;
  llmClient?: any;
  promptVersion?: string;
  timeoutMs?: number;
}

export interface RunReviewerCouncilOptions extends RunReviewerOptions {
  councilModels?: string[];
  severityThreshold?: string[];
}

function buildReviewerPrompts(patch: any, promptVersion?: string) {
  const latestTestRun = patch.testRuns?.[0];
  const testResults = latestTestRun
    ? `Status: ${latestTestRun.passed ? 'PASSED' : 'FAILED'}\nDuration: ${latestTestRun.durationMs}ms\nOutput Logs:\n${latestTestRun.logs || '(No logs recorded)'}`
    : 'No test runs recorded for this patch.';

  const systemPrompt = loadPrompt('reviewer', promptVersion ?? 'latest', {
    ticketTitle: patch.ticket.title,
    ticketDescription: patch.ticket.description,
    diff: patch.diff,
    rationale: patch.rationale || 'No rationale provided.',
    testResults
  });

  const userPrompt = `Restate the original problem described in ticket '${patch.ticket.title}' and evaluate whether the diff specifically and safely resolves that exact root cause. Return your review verdict ('pass' or 'fail') and detailed notes.`;

  return { systemPrompt, userPrompt };
}

/**
 * Runs the Reviewer Agent for a given Patch:
 * 1. Gathers the original ticket, diff, rationale, and latest TestRun result.
 * 2. Builds a prompt from the 'reviewer' template asking to restate the problem and confirm resolution.
 * 3. Calls generateStructured expecting { verdict: 'pass' | 'fail', notes: string }.
 * 4. Writes a Review row with reviewerModel recorded.
 * 5. Returns the created Review.
 */
export async function runReviewer(
  patchId: string,
  options: RunReviewerOptions = {}
): Promise<Review> {
  const prisma = options.prisma ?? defaultPrisma;
  const reviewerModel =
    options.model ??
    process.env.REVIEWER_MODEL ??
    'devstral:24b';

  // 1. Gather patch, original ticket, and latest TestRun result
  const patch = await prisma.patch.findUnique({
    where: { id: patchId },
    include: {
      ticket: {
        include: {
          project: true,
          symptomFile: true,
          rootCauseFile: true
        }
      },
      testRuns: {
        orderBy: { ranAt: 'desc' },
        take: 1
      }
    }
  });

  if (!patch) {
    throw new Error(`Patch with id '${patchId}' not found`);
  }

  // 2. Build prompt from 'reviewer' template
  const { systemPrompt, userPrompt } = buildReviewerPrompts(patch, options.promptVersion);

  // 3. Call generateStructured
  const reviewerTimeout =
    options.timeoutMs ??
    (process.env.REVIEWER_TIMEOUT_MS ? parseInt(process.env.REVIEWER_TIMEOUT_MS, 10) : 60000);

  const llmOutput = await generateStructured<ReviewerOutput>({
    model: reviewerModel,
    systemPrompt,
    userPrompt,
    schema: ReviewerOutputSchema,
    client: options.llmClient,
    promptVersion: options.promptVersion ?? 'reviewer/v1',
    timeoutMs: reviewerTimeout
  });

  // 4. Save Review row in database (single-reviewer mode: council_member: null, is_final_verdict: true)
  const review = await prisma.review.create({
    data: {
      patchId: patch.id,
      verdict: llmOutput.verdict as ReviewVerdict,
      notes: llmOutput.notes,
      reviewerModel,
      council_member: null,
      is_final_verdict: true
    }
  });

  // Record episode in team memory (.aidev/episodes.jsonl)
  try {
    const projectRoot = patch.ticket?.project?.localPath ?? process.cwd();
    const targetFile = patch.ticket?.rootCauseFile?.path ?? patch.ticket?.symptomFile?.path ?? '';
    const { MemoryAgent } = await import('./memory-agent.js');
    const memoryAgent = new MemoryAgent(projectRoot);
    await memoryAgent.recordEpisode({
      ticketId: patch.ticket.id,
      targetFile,
      title: patch.ticket.title,
      verdict: llmOutput.verdict as 'pass' | 'fail' | 'disputed',
      diffSummary: patch.diff ? patch.diff.slice(0, 300) : undefined,
      rationale: patch.rationale || undefined,
      reviewerNotes: llmOutput.notes || undefined
    });
  } catch {
    // Memory recording is non-blocking
  }

  return review;
}

/**
 * Runs the Reviewer Council for a given Patch:
 * (1) Looks up the ticket's severity for this patch.
 * (2) If severity is not 'high' or 'critical' (or below REVIEWER_COUNCIL_SEVERITY_THRESHOLD),
 *     delegates directly to runReviewer unchanged.
 * (3) Otherwise, reads model list from REVIEWER_COUNCIL_MODELS env var and runs the same
 *     reviewer prompt against each model sequentially (writing one Review row per member with
 *     council_member: index and is_final_verdict: false).
 * (4) Tallies the verdicts: if clear majority, writes a final Review row with is_final_verdict: true.
 * (5) If evenly split with no majority, writes the final Review row with verdict 'disputed'.
 */
export async function runReviewerCouncil(
  patchId: string,
  options: RunReviewerCouncilOptions = {}
): Promise<Review> {
  const prisma = options.prisma ?? defaultPrisma;

  // 1. Look up patch and ticket details
  const patch = await prisma.patch.findUnique({
    where: { id: patchId },
    include: {
      ticket: {
        include: {
          project: true,
          symptomFile: true,
          rootCauseFile: true
        }
      },
      testRuns: {
        orderBy: { ranAt: 'desc' },
        take: 1
      }
    }
  });

  if (!patch) {
    throw new Error(`Patch with id '${patchId}' not found`);
  }

  // 2. Check severity against configured threshold (default: "high,critical")
  const thresholdList = (
    options.severityThreshold ??
    (process.env.REVIEWER_COUNCIL_SEVERITY_THRESHOLD || 'high,critical').split(',')
  )
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const ticketSeverity = patch.ticket.severity.toLowerCase();
  const isCouncilEligible = thresholdList.includes(ticketSeverity);

  if (!isCouncilEligible) {
    return runReviewer(patchId, options);
  }

  // 3. Read comma-separated model list from env var or options
  const councilModels =
    options.councilModels ??
    (process.env.REVIEWER_COUNCIL_MODELS
      ? process.env.REVIEWER_COUNCIL_MODELS.split(',').map((m) => m.trim()).filter(Boolean)
      : ['qwen3-coder:30b', 'devstral:24b', 'glm-4.7-flash']);

  if (councilModels.length === 0) {
    return runReviewer(patchId, options);
  }

  const { systemPrompt, userPrompt } = buildReviewerPrompts(patch, options.promptVersion);

  const reviewerTimeout =
    options.timeoutMs ??
    (process.env.REVIEWER_TIMEOUT_MS ? parseInt(process.env.REVIEWER_TIMEOUT_MS, 10) : 60000);

  // Run each model sequentially (single GPU can't hold multiple large models loaded at once)
  const memberReviews: Review[] = [];

  for (let i = 0; i < councilModels.length; i++) {
    const model = councilModels[i];
    const llmOutput = await generateStructured<ReviewerOutput>({
      model,
      systemPrompt,
      userPrompt,
      schema: ReviewerOutputSchema,
      client: options.llmClient,
      promptVersion: options.promptVersion ?? 'reviewer/v1',
      timeoutMs: reviewerTimeout
    });

    const memberReview = await prisma.review.create({
      data: {
        patchId: patch.id,
        verdict: llmOutput.verdict as ReviewVerdict,
        notes: llmOutput.notes,
        reviewerModel: model,
        council_member: i,
        is_final_verdict: false
      }
    });

    memberReviews.push(memberReview);
  }

  // 4. Tally verdicts
  let passCount = 0;
  let failCount = 0;

  for (const r of memberReviews) {
    if (r.verdict === ReviewVerdict.pass) {
      passCount++;
    } else if (r.verdict === ReviewVerdict.fail) {
      failCount++;
    }
  }

  let finalVerdict: ReviewVerdict;
  if (passCount > failCount) {
    finalVerdict = ReviewVerdict.pass;
  } else if (failCount > passCount) {
    finalVerdict = ReviewVerdict.fail;
  } else {
    // 5. Evenly split with no majority -> 'disputed'
    finalVerdict = ReviewVerdict.disputed;
  }

  const summaryNotes =
    `Council deliberation completed with ${councilModels.length} member(s). ` +
    `Tally: ${passCount} pass, ${failCount} fail. Final verdict: ${finalVerdict}.\n\n` +
    memberReviews
      .map(
        (r, idx) =>
          `[Council Member ${idx} (${r.reviewerModel})]: ${r.verdict.toUpperCase()}\n${r.notes || '(No notes provided)'}`
      )
      .join('\n\n');

  const finalReview = await prisma.review.create({
    data: {
      patchId: patch.id,
      verdict: finalVerdict,
      notes: summaryNotes,
      reviewerModel: `council (${councilModels.join(', ')})`,
      council_member: null,
      is_final_verdict: true
    }
  });

  // Record episode in team memory (.aidev/episodes.jsonl)
  try {
    const projectRoot = patch.ticket?.project?.localPath ?? process.cwd();
    const targetFile = patch.ticket?.rootCauseFile?.path ?? patch.ticket?.symptomFile?.path ?? '';
    const { MemoryAgent } = await import('./memory-agent.js');
    const memoryAgent = new MemoryAgent(projectRoot);
    await memoryAgent.recordEpisode({
      ticketId: patch.ticket.id,
      targetFile,
      title: patch.ticket.title,
      verdict: finalVerdict as 'pass' | 'fail' | 'disputed',
      diffSummary: patch.diff ? patch.diff.slice(0, 300) : undefined,
      rationale: patch.rationale || undefined,
      reviewerNotes: summaryNotes
    });
  } catch {
    // Memory recording is non-blocking
  }

  return finalReview;
}
