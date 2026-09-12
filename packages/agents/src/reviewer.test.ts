import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma, Severity, ReviewVerdict } from '@ai-dev-team/db';
import { runReviewer, runReviewerCouncil, ReviewerOutputSchema } from './reviewer.js';

describe('Reviewer Agent', () => {
  let testProjectId: string;
  let testFileId: string;
  let correctTicketId: string;
  let correctPatchId: string;
  let wrongTicketId: string;
  let wrongPatchId: string;

  beforeAll(async () => {
    // 1. Create project and file in DB
    const project = await prisma.project.create({
      data: {
        name: `reviewer-test-project-${Date.now()}`
      }
    });
    testProjectId = project.id;

    const file = await prisma.file.create({
      data: {
        projectId: testProjectId,
        path: 'src/calculator.ts'
      }
    });
    testFileId = file.id;

    // 2. Correct patch setup
    const correctTicket = await prisma.ticket.create({
      data: {
        projectId: testProjectId,
        symptomFileId: testFileId,
        rootCauseFileId: testFileId,
        lineStart: 2,
        lineEnd: 2,
        title: 'Fix subtraction bug in calculateTotal',
        description: 'calculateTotal erroneously subtracts tax instead of adding it to price.',
        severity: Severity.high,
        confidence: 0.95,
        status: 'approved',
        scannerModel: 'qwen3:8b'
      }
    });
    correctTicketId = correctTicket.id;

    const correctPatch = await prisma.patch.create({
      data: {
        ticketId: correctTicketId,
        branchName: 'fix/ticket-correct-patch',
        diff: `--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@ -2,1 +2,1 @@\n- return price - tax;\n+ return price + tax;`,
        rationale: 'Changed subtraction to addition so tax is added to total.',
        status: 'awaiting_review',
        fixerModel: 'qwen3-coder:30b'
      }
    });
    correctPatchId = correctPatch.id;

    // Add a passing TestRun for the correct patch
    await prisma.testRun.create({
      data: {
        patchId: correctPatchId,
        passed: true,
        durationMs: 150,
        logs: '✓ calculateTotal adds price and tax as expected (passed: 1, failed: 0)'
      }
    });

    // 3. Deliberately wrong patch setup
    const wrongTicket = await prisma.ticket.create({
      data: {
        projectId: testProjectId,
        symptomFileId: testFileId,
        rootCauseFileId: testFileId,
        lineStart: 10,
        lineEnd: 15,
        title: 'Fix null pointer exception when user profile is null',
        description: 'formatUser crashes when user.profile is null during string concatenation.',
        severity: Severity.critical,
        confidence: 0.99,
        status: 'approved',
        scannerModel: 'qwen3:8b'
      }
    });
    wrongTicketId = wrongTicket.id;

    const wrongPatch = await prisma.patch.create({
      data: {
        ticketId: wrongTicketId,
        branchName: 'fix/ticket-wrong-patch',
        diff: `--- a/src/user.ts\n+++ b/src/user.ts\n@@ -10,3 +10,1 @@\n- return user.profile.name;\n+ // deleted profile access\n+ return "";`,
        rationale: 'Avoided crash by returning empty string instead of reading profile.',
        status: 'awaiting_review',
        fixerModel: 'qwen3-coder:30b'
      }
    });
    wrongPatchId = wrongPatchId = wrongPatch.id;

    // Add a failing or incomplete TestRun for the wrong patch
    await prisma.testRun.create({
      data: {
        patchId: wrongPatchId,
        passed: false,
        durationMs: 95,
        logs: 'FAIL src/user.test.ts: Expected user profile name to be formatted, received empty string'
      }
    });
  });

  afterAll(async () => {
    if (testProjectId) {
      await prisma.project.delete({
        where: { id: testProjectId }
      });
    }
  });

  it('validates ReviewerOutputSchema correctly', () => {
    const validPass = ReviewerOutputSchema.safeParse({
      verdict: 'pass',
      notes: 'Fix correctly resolves the root cause.'
    });
    expect(validPass.success).toBe(true);

    const validFail = ReviewerOutputSchema.safeParse({
      verdict: 'fail',
      notes: 'Does not resolve the ticket problem.'
    });
    expect(validFail.success).toBe(true);

    const invalidVerdict = ReviewerOutputSchema.safeParse({
      verdict: 'maybe',
      notes: 'Not sure'
    });
    expect(invalidVerdict.success).toBe(false);
  });

  it('evaluates a correct fixture patch and returns a pass Review', async () => {
    let capturedSystemPrompt = '';
    let capturedUserPrompt = '';

    const mockPassLLM = {
      chat: vi.fn().mockImplementation(async ({ messages }) => {
        capturedSystemPrompt = messages.find((m: any) => m.role === 'system')?.content || '';
        capturedUserPrompt = messages.find((m: any) => m.role === 'user')?.content || '';
        return {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              verdict: 'pass',
              notes:
                'Original problem: calculateTotal subtracted tax instead of adding it to price. The diff correctly changes price - tax to price + tax, directly resolving the defect with no regressions.'
            })
          }
        };
      })
    };

    const review = await runReviewer(correctPatchId, {
      prisma,
      model: 'devstral:24b',
      llmClient: mockPassLLM
    });

    expect(review).toBeDefined();
    expect(review.patchId).toBe(correctPatchId);
    expect(review.verdict).toBe(ReviewVerdict.pass);
    expect(review.reviewerModel).toBe('devstral:24b');
    expect(review.notes).toContain('Original problem');
    expect(review.notes).toContain('price + tax');

    // Verify prompt gathered original ticket, diff, rationale, and latest test results
    expect(capturedSystemPrompt).toContain('Fix subtraction bug in calculateTotal');
    expect(capturedSystemPrompt).toContain('return price + tax');
    expect(capturedSystemPrompt).toContain('Changed subtraction to addition');
    expect(capturedSystemPrompt).toContain('Status: PASSED');

    // Confirm stored in database
    const dbReview = await prisma.review.findUnique({
      where: { id: review.id }
    });
    expect(dbReview).not.toBeNull();
    expect(dbReview?.verdict).toBe('pass');
  });

  it('evaluates a deliberately wrong fixture patch and returns a fail Review with explanatory notes', async () => {
    let capturedSystemPrompt = '';

    const mockFailLLM = {
      chat: vi.fn().mockImplementation(async ({ messages }) => {
        capturedSystemPrompt = messages.find((m: any) => m.role === 'system')?.content || '';
        return {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              verdict: 'fail',
              notes:
                'Original problem: formatUser crashed with a null pointer exception when user.profile is null. The diff simply comments out the profile read and returns an empty string, completely breaking intended behavior and failing tests.'
            })
          }
        };
      })
    };

    const review = await runReviewer(wrongPatchId, {
      prisma,
      model: 'devstral:24b',
      llmClient: mockFailLLM
    });

    expect(review).toBeDefined();
    expect(review.patchId).toBe(wrongPatchId);
    expect(review.verdict).toBe(ReviewVerdict.fail);
    expect(review.reviewerModel).toBe('devstral:24b');
    expect(review.notes).toContain('Original problem');
    expect(review.notes).toContain('breaking intended behavior');

    // Verify captured prompt received the failing test run logs and rationale
    expect(capturedSystemPrompt).toContain('Fix null pointer exception when user profile is null');
    expect(capturedSystemPrompt).toContain('Status: FAILED');
    expect(capturedSystemPrompt).toContain('Avoided crash by returning empty string');

    // Confirm stored in database
    const dbReview = await prisma.review.findUnique({
      where: { id: review.id }
    });
    expect(dbReview).not.toBeNull();
    expect(dbReview?.verdict).toBe('fail');
  });

  it('throws an error if patchId does not exist', async () => {
    await expect(
      runReviewer('non-existent-patch-id', { prisma })
    ).rejects.toThrow("Patch with id 'non-existent-patch-id' not found");
  });

  describe('runReviewerCouncil', () => {
    it('delegates to single reviewer when ticket severity is below threshold (e.g. low)', async () => {
      // 1. Create a low severity ticket and patch
      const lowTicket = await prisma.ticket.create({
        data: {
          projectId: testProjectId,
          symptomFileId: testFileId,
          rootCauseFileId: testFileId,
          title: 'Minor formatting tweak',
          description: 'Whitespace correction in calculateTotal.',
          severity: Severity.low,
          confidence: 0.8,
          status: 'approved',
          scannerModel: 'eslint'
        }
      });

      const lowPatch = await prisma.patch.create({
        data: {
          ticketId: lowTicket.id,
          branchName: 'fix/ticket-low-patch',
          diff: `--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@ -1,1 +1,1 @@\n- const x=1;\n+ const x = 1;`,
          rationale: 'Add spacing',
          status: 'awaiting_review',
          fixerModel: 'qwen3-coder:30b'
        }
      });

      const mockSingleLLM = {
        chat: vi.fn().mockResolvedValue({
          message: {
            role: 'assistant',
            content: JSON.stringify({
              verdict: 'pass',
              notes: 'Whitespace fix verified.'
            })
          }
        })
      };

      const review = await runReviewerCouncil(lowPatch.id, {
        prisma,
        llmClient: mockSingleLLM
      });

      expect(review).toBeDefined();
      expect(review.verdict).toBe(ReviewVerdict.pass);
      expect(review.council_member).toBeNull();
      expect(review.is_final_verdict).toBe(true);

      // Verify only 1 review row exists for this patch (single reviewer mode)
      const reviews = await prisma.review.findMany({
        where: { patchId: lowPatch.id }
      });
      expect(reviews.length).toBe(1);
    });

    it('unanimous-pass: all council models pass, produces member rows and final pass row', async () => {
      const councilModels = ['model-alpha', 'model-beta', 'model-gamma'];
      const modelsCalled: string[] = [];

      const mockUnanimousPassLLM = {
        chat: vi.fn().mockImplementation(async ({ model }) => {
          modelsCalled.push(model);
          return {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                verdict: 'pass',
                notes: `Model ${model} confirmed the patch completely resolves the ticket.`
              })
            }
          };
        })
      };

      const finalReview = await runReviewerCouncil(correctPatchId, {
        prisma,
        councilModels,
        llmClient: mockUnanimousPassLLM
      });

      // Verify sequential execution of all models
      expect(modelsCalled).toEqual(councilModels);

      // Verify final review returned
      expect(finalReview).toBeDefined();
      expect(finalReview.verdict).toBe(ReviewVerdict.pass);
      expect(finalReview.is_final_verdict).toBe(true);
      expect(finalReview.council_member).toBeNull();
      expect(finalReview.reviewerModel).toContain('council (model-alpha, model-beta, model-gamma)');
      expect(finalReview.notes).toContain('Tally: 3 pass, 0 fail');

      // Verify rows in database
      const reviews = await prisma.review.findMany({
        where: { patchId: correctPatchId },
        orderBy: { reviewedAt: 'asc' }
      });

      const memberRows = reviews.filter((r) => !r.is_final_verdict);
      expect(memberRows.length).toBe(3);
      memberRows.forEach((r, idx) => {
        expect(r.council_member).toBe(idx);
        expect(r.reviewerModel).toBe(councilModels[idx]);
        expect(r.verdict).toBe(ReviewVerdict.pass);
        expect(r.is_final_verdict).toBe(false);
      });
    });

    it('unanimous-fail: all council models fail, produces member rows and final fail row', async () => {
      const councilModels = ['model-one', 'model-two', 'model-three'];

      const mockUnanimousFailLLM = {
        chat: vi.fn().mockImplementation(async ({ model }) => {
          return {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                verdict: 'fail',
                notes: `Model ${model} rejected the patch: logic error still present.`
              })
            }
          };
        })
      };

      const finalReview = await runReviewerCouncil(wrongPatchId, {
        prisma,
        councilModels,
        llmClient: mockUnanimousFailLLM
      });

      expect(finalReview).toBeDefined();
      expect(finalReview.verdict).toBe(ReviewVerdict.fail);
      expect(finalReview.is_final_verdict).toBe(true);
      expect(finalReview.council_member).toBeNull();
      expect(finalReview.notes).toContain('Tally: 0 pass, 3 fail');

      const reviews = await prisma.review.findMany({
        where: { patchId: wrongPatchId, is_final_verdict: false }
      });
      expect(reviews.length).toBe(3);
      reviews.forEach((r, idx) => {
        expect(r.council_member).toBe(idx);
        expect(r.verdict).toBe(ReviewVerdict.fail);
      });
    });

    it('forced-split: evenly split (1 pass, 1 fail) results in disputed final verdict', async () => {
      const councilModels = ['model-optimist', 'model-pessimist'];

      const mockSplitLLM = {
        chat: vi.fn().mockImplementation(async ({ model }) => {
          if (model === 'model-optimist') {
            return {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  verdict: 'pass',
                  notes: 'Passes in my opinion.'
                })
              }
            };
          } else {
            return {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  verdict: 'fail',
                  notes: 'Fails due to edge case.'
                })
              }
            };
          }
        })
      };

      // Create a dedicated patch for the split test
      const splitPatch = await prisma.patch.create({
        data: {
          ticketId: correctTicketId, // high severity ticket
          branchName: 'fix/ticket-split-patch',
          diff: '--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@ -2,1 +2,1 @@\n- return price;\n+ return price * 1.1;',
          status: 'awaiting_review',
          fixerModel: 'qwen3-coder:30b'
        }
      });

      const finalReview = await runReviewerCouncil(splitPatch.id, {
        prisma,
        councilModels,
        llmClient: mockSplitLLM
      });

      expect(finalReview).toBeDefined();
      expect(finalReview.verdict).toBe(ReviewVerdict.disputed);
      expect(finalReview.is_final_verdict).toBe(true);
      expect(finalReview.council_member).toBeNull();
      expect(finalReview.notes).toContain('Tally: 1 pass, 1 fail');
      expect(finalReview.notes).toContain('Final verdict: disputed');

      // Verify member rows
      const memberReviews = await prisma.review.findMany({
        where: { patchId: splitPatch.id, is_final_verdict: false },
        orderBy: { council_member: 'asc' }
      });
      expect(memberReviews.length).toBe(2);
      expect(memberReviews[0].council_member).toBe(0);
      expect(memberReviews[0].verdict).toBe(ReviewVerdict.pass);
      expect(memberReviews[1].council_member).toBe(1);
      expect(memberReviews[1].verdict).toBe(ReviewVerdict.fail);
    });

    it('respects REVIEWER_COUNCIL_SEVERITY_THRESHOLD and REVIEWER_COUNCIL_MODELS env vars', async () => {
      const prevThreshold = process.env.REVIEWER_COUNCIL_SEVERITY_THRESHOLD;
      const prevModels = process.env.REVIEWER_COUNCIL_MODELS;

      try {
        process.env.REVIEWER_COUNCIL_SEVERITY_THRESHOLD = 'critical';
        process.env.REVIEWER_COUNCIL_MODELS = 'env-model-a,env-model-b';

        const modelsInvoked: string[] = [];
        const mockEnvLLM = {
          chat: vi.fn().mockImplementation(async ({ model }) => {
            modelsInvoked.push(model);
            return {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  verdict: 'pass',
                  notes: `Model ${model} approved.`
                })
              }
            };
          })
        };

        // correctTicketId has severity 'high', which is NOT 'critical' under this env threshold
        const reviewHigh = await runReviewerCouncil(correctPatchId, {
          prisma,
          llmClient: mockEnvLLM
        });
        // Should delegate to single model, not council
        expect(reviewHigh.council_member).toBeNull();
        expect(reviewHigh.is_final_verdict).toBe(true);
        expect(modelsInvoked).toContain('devstral:24b'); // default single model

        modelsInvoked.length = 0;

        // wrongTicketId has severity 'critical', which matches threshold
        const reviewCritical = await runReviewerCouncil(wrongPatchId, {
          prisma,
          llmClient: mockEnvLLM
        });

        // Council env models should have been invoked sequentially
        expect(modelsInvoked).toEqual(['env-model-a', 'env-model-b']);
        expect(reviewCritical.is_final_verdict).toBe(true);
        expect(reviewCritical.verdict).toBe(ReviewVerdict.pass);
      } finally {
        process.env.REVIEWER_COUNCIL_SEVERITY_THRESHOLD = prevThreshold;
        process.env.REVIEWER_COUNCIL_MODELS = prevModels;
      }
    });
  });
});
