import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { prisma, Severity, ReviewVerdict } from '@ai-dev-team/db';
import {
  runApprovalPipeline,
  processFixerJob,
  processTestWriterJob,
  processSandboxJob,
  processReviewerJob
} from './queues/approval-loop.js';
import { clearQueuedJobs, getQueuedJobs } from './queues/index.js';

describe('Approval Loop with Retry Cap (Prompt 8.2)', () => {
  let testProjectId: string;
  let testFileId: string;

  beforeAll(async () => {
    const project = await prisma.project.create({
      data: {
        name: `approval-loop-test-${Date.now()}`
      }
    });
    testProjectId = project.id;

    const file = await prisma.file.create({
      data: {
        projectId: testProjectId,
        path: 'src/service.ts'
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
  });

  beforeEach(() => {
    clearQueuedJobs();
  });

  it('completes the pipeline and sets status to awaiting_human when Reviewer verdict is pass', async () => {
    const ticket = await prisma.ticket.create({
      data: {
        projectId: testProjectId,
        symptomFileId: testFileId,
        rootCauseFileId: testFileId,
        title: 'Fix math bug',
        description: 'Incorrect calculation in service',
        severity: Severity.high,
        confidence: 0.95,
        status: 'approved',
        scannerModel: 'qwen3:8b'
      }
    });

    let fixerCallCount = 0;
    const mockRunFixer = vi.fn().mockImplementation(async (tId: string) => {
      fixerCallCount++;
      return prisma.patch.create({
        data: {
          ticketId: tId,
          branchName: `fix/ticket-${tId}-1`,
          diff: '+ fixed code',
          rationale: 'Correct fix',
          status: 'awaiting_review',
          fixerModel: 'qwen3-coder:30b'
        }
      });
    });

    const mockRunTestWriter = vi.fn().mockResolvedValue(undefined);

    const mockRunTests = vi.fn().mockImplementation(async (pId: string) => {
      return prisma.testRun.create({
        data: {
          patchId: pId,
          passed: true,
          durationMs: 120,
          logs: 'All tests passed'
        }
      });
    });

    const mockRunReviewer = vi.fn().mockImplementation(async (pId: string) => {
      return prisma.review.create({
        data: {
          patchId: pId,
          verdict: ReviewVerdict.pass,
          notes: 'Patch resolves the defect cleanly.',
          reviewerModel: 'devstral:24b'
        }
      });
    });

    const result = await runApprovalPipeline(ticket.id, {
      prisma,
      runFixerFn: mockRunFixer,
      runTestWriterFn: mockRunTestWriter,
      runTestsFn: mockRunTests,
      runReviewerFn: mockRunReviewer
    });

    expect(result.finalStatus).toBe('awaiting_human');
    expect(mockRunFixer).toHaveBeenCalledTimes(1);
    expect(mockRunTestWriter).toHaveBeenCalledTimes(1);
    expect(mockRunTests).toHaveBeenCalledTimes(1);
    expect(mockRunReviewer).toHaveBeenCalledTimes(1);

    // Verify DB state
    const updatedTicket = await prisma.ticket.findUnique({
      where: { id: ticket.id }
    });
    expect(updatedTicket?.status).toBe('awaiting_human');
    expect(updatedTicket?.retryCount).toBe(0);
  });

  it('retries when Reviewer fails, passes reviewer notes to Fixer, and stops at failed_needs_human after hitting retry cap', async () => {
    const ticket = await prisma.ticket.create({
      data: {
        projectId: testProjectId,
        symptomFileId: testFileId,
        rootCauseFileId: testFileId,
        title: 'Fix null crash',
        description: 'Crash when accessing null object',
        severity: Severity.critical,
        confidence: 0.99,
        status: 'approved',
        retryCount: 0,
        scannerModel: 'qwen3:8b'
      }
    });

    const capturedNotesOnFixer: (string | undefined)[] = [];
    let fixerCallCount = 0;

    const mockRunFixer = vi.fn().mockImplementation(async (tId: string, options: any) => {
      fixerCallCount++;
      capturedNotesOnFixer.push(options?.reviewerNotes);
      return prisma.patch.create({
        data: {
          ticketId: tId,
          branchName: `fix/ticket-${tId}-${fixerCallCount}`,
          diff: `+ attempt ${fixerCallCount}`,
          rationale: `Attempt ${fixerCallCount}`,
          status: 'awaiting_review',
          fixerModel: 'qwen3-coder:30b'
        }
      });
    });

    const mockRunTestWriter = vi.fn().mockResolvedValue(undefined);

    const mockRunTests = vi.fn().mockImplementation(async (pId: string) => {
      return prisma.testRun.create({
        data: {
          patchId: pId,
          passed: false,
          durationMs: 90,
          logs: 'Assertion failed'
        }
      });
    });

    let reviewerCallCount = 0;
    const mockRunReviewer = vi.fn().mockImplementation(async (pId: string) => {
      reviewerCallCount++;
      return prisma.review.create({
        data: {
          patchId: pId,
          verdict: ReviewVerdict.fail,
          notes: `Critique ${reviewerCallCount}: Patch ${reviewerCallCount} does not solve the root cause.`,
          reviewerModel: 'devstral:24b'
        }
      });
    });

    // Run pipeline with maxRetries = 2
    const result = await runApprovalPipeline(ticket.id, {
      prisma,
      runFixerFn: mockRunFixer,
      runTestWriterFn: mockRunTestWriter,
      runTestsFn: mockRunTests,
      runReviewerFn: mockRunReviewer,
      maxRetries: 2
    });

    // Initial attempt + 2 retries = 3 total Fixer calls
    expect(mockRunFixer).toHaveBeenCalledTimes(3);
    expect(mockRunTestWriter).toHaveBeenCalledTimes(3);
    expect(mockRunTests).toHaveBeenCalledTimes(3);
    expect(mockRunReviewer).toHaveBeenCalledTimes(3);

    // Initial attempt had no reviewer notes, subsequent retries received notes
    expect(capturedNotesOnFixer[0]).toBeUndefined();
    expect(capturedNotesOnFixer[1]).toContain('Critique 1');
    expect(capturedNotesOnFixer[2]).toContain('Critique 2');

    // Result should be failed_needs_human
    expect(result.finalStatus).toBe('failed_needs_human');
    expect(result.retryCount).toBe(2);

    // Verify DB state
    const finalTicket = await prisma.ticket.findUnique({
      where: { id: ticket.id }
    });
    expect(finalTicket?.status).toBe('failed_needs_human');
    expect(finalTicket?.retryCount).toBe(2);
  });

  it('succeeds on retry before hitting the cap and transitions to awaiting_human', async () => {
    const ticket = await prisma.ticket.create({
      data: {
        projectId: testProjectId,
        symptomFileId: testFileId,
        rootCauseFileId: testFileId,
        title: 'Intermittent bug',
        description: 'Bug that takes two attempts to fix',
        severity: Severity.medium,
        confidence: 0.9,
        status: 'approved',
        retryCount: 0,
        scannerModel: 'qwen3:8b'
      }
    });

    let attempt = 0;
    const mockRunFixer = vi.fn().mockImplementation(async (tId: string) => {
      attempt++;
      return prisma.patch.create({
        data: {
          ticketId: tId,
          branchName: `fix/ticket-${tId}-${attempt}`,
          diff: `+ code attempt ${attempt}`,
          rationale: `Fix attempt ${attempt}`,
          status: 'awaiting_review',
          fixerModel: 'qwen3-coder:30b'
        }
      });
    });

    const mockRunTestWriter = vi.fn().mockResolvedValue(undefined);
    const mockRunTests = vi.fn().mockImplementation(async (pId: string) => {
      return prisma.testRun.create({
        data: {
          patchId: pId,
          passed: attempt > 1,
          durationMs: 100,
          logs: attempt > 1 ? 'Passed' : 'Failed'
        }
      });
    });

    const mockRunReviewer = vi.fn().mockImplementation(async (pId: string) => {
      // First attempt fails, second attempt passes
      const isPass = attempt > 1;
      return prisma.review.create({
        data: {
          patchId: pId,
          verdict: isPass ? ReviewVerdict.pass : ReviewVerdict.fail,
          notes: isPass ? 'Resolved on attempt 2' : 'Failed on attempt 1',
          reviewerModel: 'devstral:24b'
        }
      });
    });

    const result = await runApprovalPipeline(ticket.id, {
      prisma,
      runFixerFn: mockRunFixer,
      runTestWriterFn: mockRunTestWriter,
      runTestsFn: mockRunTests,
      runReviewerFn: mockRunReviewer,
      maxRetries: 2
    });

    expect(result.finalStatus).toBe('awaiting_human');
    expect(mockRunFixer).toHaveBeenCalledTimes(2);

    const finalTicket = await prisma.ticket.findUnique({
      where: { id: ticket.id }
    });
    expect(finalTicket?.status).toBe('awaiting_human');
    expect(finalTicket?.retryCount).toBe(1);
  });

  it('handles disputed verdict from Reviewer Council by setting status to awaiting_human_dispute without fixer retry', async () => {
    const ticket = await prisma.ticket.create({
      data: {
        projectId: testProjectId,
        symptomFileId: testFileId,
        rootCauseFileId: testFileId,
        title: 'Fix edge case with disputed council vote',
        description: 'Council split on performance tradeoff',
        severity: Severity.high,
        confidence: 0.9,
        status: 'approved',
        retryCount: 0,
        scannerModel: 'qwen3:8b'
      }
    });

    const mockRunFixer = vi.fn().mockImplementation(async (tId: string) => {
      return prisma.patch.create({
        data: {
          ticketId: tId,
          branchName: 'fix/ticket-disputed-test',
          diff: '--- a/src/calc.ts\n+++ b/src/calc.ts\n@@ -1,1 +1,1 @@\n- return 0;\n+ return 1;',
          status: 'awaiting_review',
          fixerModel: 'qwen3-coder:30b'
        }
      });
    });

    const mockRunTestWriter = vi.fn().mockResolvedValue(undefined);
    const mockRunTests = vi.fn().mockImplementation(async (pId: string) => {
      return prisma.testRun.create({
        data: {
          patchId: pId,
          passed: true,
          durationMs: 100,
          logs: 'Passed'
        }
      });
    });

    const mockRunReviewer = vi.fn().mockImplementation(async (pId: string) => {
      return prisma.review.create({
        data: {
          patchId: pId,
          verdict: ReviewVerdict.disputed,
          notes: 'Council vote evenly split: 1 pass, 1 fail.',
          reviewerModel: 'council (model-a, model-b)',
          council_member: null,
          is_final_verdict: true
        }
      });
    });

    const result = await runApprovalPipeline(ticket.id, {
      prisma,
      runFixerFn: mockRunFixer,
      runTestWriterFn: mockRunTestWriter,
      runTestsFn: mockRunTests,
      runReviewerFn: mockRunReviewer,
      maxRetries: 2
    });

    // Final status should be awaiting_human_dispute
    expect(result.finalStatus).toBe('awaiting_human_dispute');

    // Fixer was called only 1 time (not retried)
    expect(mockRunFixer).toHaveBeenCalledTimes(1);

    // Verify DB state
    const updatedTicket = await prisma.ticket.findUnique({
      where: { id: ticket.id }
    });
    expect(updatedTicket?.status).toBe('awaiting_human_dispute');
    expect(updatedTicket?.retryCount).toBe(0);
  });
});
