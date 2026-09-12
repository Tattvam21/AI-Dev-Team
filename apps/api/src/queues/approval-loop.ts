import { prisma as defaultPrisma, PrismaClient, Review, Ticket, Patch, TestRun } from '@ai-dev-team/db';
import { runFixer, runTestWriter, runTests, runReviewer, runReviewerCouncil, runScan, runTriage } from '@ai-dev-team/agents';
import { ScanJobData, FixerJobData, TestWriterJobData, SandboxJobData, ReviewerJobData } from './types.js';
import {
  enqueueFixerJob,
  enqueueTestWriterJob,
  enqueueSandboxJob,
  enqueueReviewerJob
} from './index.js';
import { transitionTicket } from '../state-machine.js';
import { broadcastTicketEvent } from '../ws.js';

export async function processScanJob(
  data: ScanJobData,
  options: any = {}
): Promise<{ ticketsFound: number }> {
  const prisma = options.prisma ?? defaultPrisma;
  const project = await prisma.project.findUnique({
    where: { id: data.projectId }
  });

  if (!project) {
    throw new Error(`Project not found: ${data.projectId}`);
  }

  const broadcastProgress = (progress: any) => {
    broadcastTicketEvent(project.id, {
      type: 'scan_progress',
      projectId: project.id,
      ticketId: '',
      status: progress.stage,
      actor: 'scanner',
      details: progress,
      timestamp: new Date().toISOString()
    } as any);
  };

  broadcastProgress({
    stage: 'starting',
    current: 0,
    total: 100,
    message: `Starting scan for ${project.name}...`
  });

  console.log(`[ScanWorker] Starting scan for project: ${project.name} (${project.id})...`);

  try {
    const tickets = await runScan(project.id, {
      prisma,
      onProgress: (p: any) => {
        console.log(`[ScanWorker] ${p.stage}: ${p.message}`);
        broadcastProgress(p);
      },

      ...options.scanOptions
    });

    console.log(`[ScanWorker] Scan found ${tickets.length} tickets. Running triage...`);

    broadcastProgress({
      stage: 'triage',
      current: 95,
      total: 100,
      message: `Triage agent: deduplicating and prioritizing ${tickets.length} finding(s)...`
    });

    await runTriage(project.id, { prisma, ...options.triageOptions });
    console.log(`[ScanWorker] Triage complete for project: ${project.name}`);

    broadcastProgress({
      stage: 'completed',
      current: 100,
      total: 100,
      message: `Scan & triage complete! Found ${tickets.length} ticket(s).`,
      ticketsFound: tickets.length
    });

    broadcastTicketEvent(project.id, {
      type: 'ticket_created',
      ticketId: '',
      projectId: project.id,
      status: 'triaged',
      actor: 'scanner',
      timestamp: new Date().toISOString()
    });

    return { ticketsFound: tickets.length };
  } catch (err: any) {
    console.error(`[ScanWorker] Scan failed for project ${project.name}:`, err);
    broadcastProgress({
      stage: 'error',
      current: 0,
      total: 100,
      message: `Scan failed: ${err.message || err}`
    });
    throw err;
  }
}


export interface ApprovalPipelineOptions {
  prisma?: PrismaClient;
  runFixerFn?: (ticketId: string, options?: any) => Promise<Patch>;
  runTestWriterFn?: (patchId: string, options?: any) => Promise<void>;
  runTestsFn?: (patchId: string, options?: any) => Promise<TestRun>;
  runReviewerFn?: (patchId: string, options?: any) => Promise<Review>;
  fixerOptions?: any;
  testWriterOptions?: any;
  sandboxOptions?: any;
  reviewerOptions?: any;
  autoProgress?: boolean;
  maxRetries?: number;
}


export interface ReviewerStepResult {
  verdict: 'pass' | 'fail' | 'disputed';
  status: string;
  retrying: boolean;
  retryCount: number;
  review: Review;
}

/**
 * Step 1: Executes Fixer agent for an approved ticket.
 * - Transitions ticket status to 'fixing'
 * - Calls runFixer (passing any previous reviewer feedback notes)
 * - Transitions ticket status to 'in_review'
 * - Enqueues/triggers TestWriter step
 */
export async function processFixerJob(
  data: FixerJobData,
  options: ApprovalPipelineOptions = {}
): Promise<Patch> {
  const prisma = options.prisma ?? defaultPrisma;
  const runFixerImpl = options.runFixerFn ?? runFixer;

  // Transition status to 'fixing'
  await transitionTicket(data.ticketId, 'fixing', {
    actor: 'fixer',
    details: { reviewerNotes: data.reviewerNotes ?? null },
    prisma
  });

  try {
    const patch = await runFixerImpl(data.ticketId, {
      prisma,
      reviewerNotes: data.reviewerNotes,
      ...options.fixerOptions
    });

    // Transition status to 'in_review'
    await transitionTicket(data.ticketId, 'in_review', {
      actor: 'fixer',
      details: { patchId: patch.id },
      prisma
    });

    if (options.autoProgress !== false) {
      await enqueueTestWriterJob(patch.id, data.ticketId, data.projectId);
    }

    return patch;
  } catch (err: any) {
    const isTimeout =
      err.name === 'LLMTimeoutError' || /timed? out/i.test(err.message);
    const failureStatus = isTimeout ? 'fix_timeout' : 'fix_failed';

    await transitionTicket(data.ticketId, failureStatus, {
      actor: 'fixer',
      action: failureStatus,
      details: { error: err.message },
      prisma
    }).catch(() => {});

    throw err;
  }
}

/**
 * Step 2: Executes Test-Writer agent for a patch.
 * - Calls runTestWriter to write regression tests and commit to branch
 * - Enqueues/triggers Sandbox step
 */
export async function processTestWriterJob(
  data: TestWriterJobData,
  options: ApprovalPipelineOptions = {}
): Promise<void> {
  const prisma = options.prisma ?? defaultPrisma;
  const runTestWriterImpl = options.runTestWriterFn ?? runTestWriter;

  try {
    await runTestWriterImpl(data.patchId, {
      prisma,
      ...options.testWriterOptions
    });

    if (options.autoProgress !== false) {
      await enqueueSandboxJob(data.patchId, data.ticketId, data.projectId);
    }
  } catch (err: any) {
    const isTimeout =
      err.name === 'LLMTimeoutError' || /timed? out/i.test(err.message);
    const failureStatus = isTimeout ? 'test_writer_timeout' : 'test_writer_failed';

    await transitionTicket(data.ticketId, failureStatus, {
      actor: 'test-writer',
      action: failureStatus,
      details: { patchId: data.patchId, error: err.message },
      prisma
    }).catch(() => {});

    throw err;
  }
}

/**
 * Step 3: Executes Sandbox test runner inside Docker.
 * - Calls runTests to run isolated test suite and record TestRun
 * - Enqueues/triggers Reviewer step
 */
export async function processSandboxJob(
  data: SandboxJobData,
  options: ApprovalPipelineOptions = {}
): Promise<TestRun> {
  const prisma = options.prisma ?? defaultPrisma;
  const runTestsImpl = options.runTestsFn ?? runTests;

  try {
    const testRun = await runTestsImpl(data.patchId, {
      prisma,
      ...options.sandboxOptions
    });

    if (options.autoProgress !== false) {
      await enqueueReviewerJob(data.patchId, data.ticketId, data.projectId);
    }

    return testRun;
  } catch (err: any) {
    const isTimeout = /timed? out/i.test(err.message);
    const failureStatus = isTimeout ? 'sandbox_timeout' : 'sandbox_failed';

    await transitionTicket(data.ticketId, failureStatus, {
      actor: 'sandbox',
      action: failureStatus,
      details: { patchId: data.patchId, error: err.message },
      prisma
    }).catch(() => {});

    throw err;
  }
}

/**
 * Step 4: Executes Reviewer agent to evaluate patch against ticket.
 * - Calls runReviewer
 * - If verdict is 'pass': sets ticket status to 'awaiting_human'
 * - If verdict is 'fail':
 *     - If retryCount < maxRetries (default 2):
 *         increments retryCount, re-enqueues Fixer job with reviewer's notes
 *     - If retryCount >= maxRetries:
 *         sets ticket status to 'failed_needs_human'
 */
export async function processReviewerJob(
  data: ReviewerJobData,
  options: ApprovalPipelineOptions = {}
): Promise<ReviewerStepResult> {
  const prisma = options.prisma ?? defaultPrisma;
  const runReviewerImpl = options.runReviewerFn ?? runReviewerCouncil;
  const maxRetries = options.maxRetries ?? 2;

  let review: Review;
  try {
    review = await runReviewerImpl(data.patchId, {
      prisma,
      ...options.reviewerOptions
    });
  } catch (err: any) {
    const isTimeout =
      err.name === 'LLMTimeoutError' || /timed? out/i.test(err.message);
    const failureStatus = isTimeout ? 'reviewer_timeout' : 'reviewer_failed';

    await transitionTicket(data.ticketId, failureStatus, {
      actor: 'reviewer',
      action: failureStatus,
      details: { patchId: data.patchId, error: err.message },
      prisma
    }).catch(() => {});

    throw err;
  }

  if (review.verdict === 'pass') {
    const { ticket: updatedTicket } = await transitionTicket(data.ticketId, 'awaiting_human', {
      actor: 'reviewer',
      details: { verdict: 'pass', reviewId: review.id },
      prisma
    });

    return {
      verdict: 'pass',
      status: updatedTicket.status,
      retrying: false,
      retryCount: 0,
      review
    };
  }

  if (review.verdict === 'disputed') {
    const { ticket: updatedTicket } = await transitionTicket(data.ticketId, 'awaiting_human_dispute', {
      actor: 'reviewer',
      details: {
        verdict: 'disputed',
        reviewId: review.id,
        notes: review.notes ?? null,
        reason: 'Council split vote; awaiting human resolution'
      },
      prisma
    });

    return {
      verdict: 'disputed',
      status: updatedTicket.status,
      retrying: false,
      retryCount: 0,
      review
    };
  }

  // Verdict is 'fail'
  const ticket = await prisma.ticket.findUnique({
    where: { id: data.ticketId }
  });

  if (!ticket) {
    throw new Error(`Ticket with id '${data.ticketId}' not found`);
  }

  const currentRetries = ticket.retryCount ?? 0;

  if (currentRetries < maxRetries) {
    const { ticket: updatedTicket } = await transitionTicket(data.ticketId, 'in_review', {
      actor: 'reviewer',
      details: {
        verdict: 'fail',
        reviewId: review.id,
        notes: review.notes ?? null,
        retrying: true
      },
      additionalData: {
        retryCount: { increment: 1 } as any
      },
      prisma
    });

    if (options.autoProgress !== false) {
      await enqueueFixerJob(
        data.ticketId,
        data.projectId ?? ticket.projectId,
        review.notes ?? undefined
      );
    }

    return {
      verdict: 'fail',
      status: updatedTicket.status,
      retrying: true,
      retryCount: updatedTicket.retryCount,
      review
    };
  } else {
    // Retry cap exceeded -> failed_needs_human
    const { ticket: updatedTicket } = await transitionTicket(data.ticketId, 'failed_needs_human', {
      actor: 'reviewer',
      details: {
        verdict: 'fail',
        reviewId: review.id,
        notes: review.notes ?? null,
        retryCapExceeded: true
      },
      prisma
    });

    return {
      verdict: 'fail',
      status: updatedTicket.status,
      retrying: false,
      retryCount: currentRetries,
      review
    };
  }
}

/**
 * Convenience orchestrator for running or simulating the full approval loop:
 * Fixer -> Test-Writer -> Sandbox -> Reviewer -> (Retry / Approval / Failed)
 */
export async function runApprovalPipeline(
  ticketId: string,
  options: ApprovalPipelineOptions = {}
): Promise<{ finalStatus: string; retryCount: number; lastReview: Review }> {
  const prisma = options.prisma ?? defaultPrisma;
  let reviewerNotes: string | undefined = undefined;

  while (true) {
    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new Error(`Ticket ${ticketId} not found`);

    // 1. Fixer Step
    const patch = await processFixerJob(
      { ticketId, projectId: ticket.projectId, reviewerNotes },
      { ...options, autoProgress: false }
    );

    // 2. Test-Writer Step
    await processTestWriterJob(
      { patchId: patch.id, ticketId, projectId: ticket.projectId },
      { ...options, autoProgress: false }
    );

    // 3. Sandbox Step
    await processSandboxJob(
      { patchId: patch.id, ticketId, projectId: ticket.projectId },
      { ...options, autoProgress: false }
    );

    // 4. Reviewer Step
    const reviewResult = await processReviewerJob(
      { patchId: patch.id, ticketId, projectId: ticket.projectId },
      { ...options, autoProgress: false }
    );

    if (reviewResult.verdict === 'pass') {
      return {
        finalStatus: reviewResult.status,
        retryCount: reviewResult.retryCount,
        lastReview: reviewResult.review
      };
    }

    if (!reviewResult.retrying) {
      // Hit retry cap -> failed_needs_human
      return {
        finalStatus: reviewResult.status,
        retryCount: reviewResult.retryCount,
        lastReview: reviewResult.review
      };
    }

    // Set notes for the next retry iteration
    reviewerNotes = reviewResult.review.notes ?? undefined;
  }
}
