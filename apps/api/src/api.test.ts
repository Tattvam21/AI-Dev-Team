import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { prisma, Severity } from '@ai-dev-team/db';
import { buildApp } from './app.js';
import { getQueuedJobs, clearQueuedJobs, closeQueues } from './queue.js';

describe('Fastify REST API & State Machine Integration', () => {
  let app: FastifyInstance;
  let testProjectId: string;
  let testFileId: string;

  beforeAll(async () => {
    app = buildApp({ logger: false });
    await app.ready();

    // Create a base test project
    const project = await prisma.project.create({
      data: {
        name: `api-test-${Date.now()}`,
        localPath: '/tmp/api-test-project'
      }
    });
    testProjectId = project.id;

    const file = await prisma.file.create({
      data: {
        projectId: testProjectId,
        path: 'src/index.ts'
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
    await app.close();
    await closeQueues();
    await prisma.$disconnect();
  });

  beforeEach(() => {
    clearQueuedJobs();
  });

  describe('POST /projects & POST /projects/:id/scan', () => {
    it('should create a new project via POST /projects', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/projects',
        payload: {
          name: 'Manual Test Project',
          localPath: '/tmp/manual-test-project'
        }
      });

      expect(response.statusCode).toBe(201);
      const json = JSON.parse(response.body);
      expect(json.id).toBeDefined();
      expect(json.name).toBe('Manual Test Project');
      expect(json.localPath).toBe('/tmp/manual-test-project');

      // Verify row in database
      const row = await prisma.project.findUnique({
        where: { id: json.id }
      });
      expect(row).not.toBeNull();

      // Clean up created project
      await prisma.project.delete({ where: { id: json.id } });
    });

    it('should enqueue a scan job via POST /projects/:id/scan', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/projects/${testProjectId}/scan`
      });

      expect(response.statusCode).toBe(202);
      const json = JSON.parse(response.body);
      expect(json.success).toBe(true);
      expect(json.jobId).toBeDefined();
      expect(json.projectId).toBe(testProjectId);

      // Verify queued job exists
      const queued = getQueuedJobs('scan-queue');
      expect(queued.length).toBe(1);
      expect(queued[0].data.projectId).toBe(testProjectId);
    });

    it('should return 404 when scanning non-existent project', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/projects/non-existent-uuid/scan'
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /projects/:id/tickets', () => {
    beforeAll(async () => {
      await prisma.ticket.createMany({
        data: [
          {
            projectId: testProjectId,
            symptomFileId: testFileId,
            title: 'Found Ticket Critical',
            description: 'desc',
            severity: Severity.critical,
            confidence: 0.9,
            status: 'found',
            scannerModel: 'qwen3:8b'
          },
          {
            projectId: testProjectId,
            symptomFileId: testFileId,
            title: 'Triaged Ticket High',
            description: 'desc',
            severity: Severity.high,
            confidence: 0.8,
            status: 'triaged',
            scannerModel: 'qwen3:8b'
          }
        ]
      });
    });

    it('should list tickets for project with optional status and severity filtering', async () => {
      // All tickets
      const resAll = await app.inject({
        method: 'GET',
        url: `/projects/${testProjectId}/tickets`
      });
      expect(resAll.statusCode).toBe(200);
      const all = JSON.parse(resAll.body);
      expect(all.length).toBeGreaterThanOrEqual(2);

      // Filter by status=triaged
      const resTriaged = await app.inject({
        method: 'GET',
        url: `/projects/${testProjectId}/tickets?status=triaged`
      });
      expect(resTriaged.statusCode).toBe(200);
      const triaged = JSON.parse(resTriaged.body);
      expect(triaged.every((t: any) => t.status === 'triaged')).toBe(true);

      // Filter by severity=critical
      const resCritical = await app.inject({
        method: 'GET',
        url: `/projects/${testProjectId}/tickets?severity=critical`
      });
      expect(resCritical.statusCode).toBe(200);
      const critical = JSON.parse(resCritical.body);
      expect(critical.every((t: any) => t.severity === 'critical')).toBe(true);
    });
  });

  describe('Ticket State Machine & Approval / Rejection Routes', () => {
    it('happy path: should approve a triaged ticket, set status to approved, and enqueue fixer job', async () => {
      const ticket = await prisma.ticket.create({
        data: {
          projectId: testProjectId,
          symptomFileId: testFileId,
          title: 'Ready for Fix',
          description: 'A well-scoped bug',
          severity: Severity.high,
          confidence: 0.95,
          status: 'triaged',
          scannerModel: 'qwen3:8b'
        }
      });

      const response = await app.inject({
        method: 'POST',
        url: `/tickets/${ticket.id}/approve`
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.body);
      expect(json.ticket.status).toBe('approved');
      expect(json.jobId).toBeDefined();

      // Verify DB update
      const dbTicket = await prisma.ticket.findUnique({
        where: { id: ticket.id }
      });
      expect(dbTicket?.status).toBe('approved');

      // Verify fixer job enqueued
      const fixerJobs = getQueuedJobs('fixer-queue');
      expect(fixerJobs.length).toBe(1);
      expect(fixerJobs[0].data.ticketId).toBe(ticket.id);

      // Verify audit log recorded
      const audit = await prisma.auditLog.findFirst({
        where: { ticketId: ticket.id, action: 'approved' }
      });
      expect(audit).not.toBeNull();
      expect(audit?.actor).toBe('human');
    });

    it('invalid transition: should reject approval with 409 when ticket is in status found (not triaged)', async () => {
      const ticket = await prisma.ticket.create({
        data: {
          projectId: testProjectId,
          symptomFileId: testFileId,
          title: 'Un-triaged Bug',
          description: 'Still in found status',
          severity: Severity.medium,
          confidence: 0.5,
          status: 'found',
          scannerModel: 'eslint'
        }
      });

      const response = await app.inject({
        method: 'POST',
        url: `/tickets/${ticket.id}/approve`
      });

      expect(response.statusCode).toBe(409);
      const json = JSON.parse(response.body);
      expect(json.error).toBe('Conflict');
      expect(json.message).toContain('triaged');

      // Verify ticket status remained unchanged
      const dbTicket = await prisma.ticket.findUnique({
        where: { id: ticket.id }
      });
      expect(dbTicket?.status).toBe('found');

      // Verify no fixer job was enqueued
      const fixerJobs = getQueuedJobs('fixer-queue');
      expect(fixerJobs.length).toBe(0);
    });

    it('happy path: should reject a ticket and set status to rejected', async () => {
      const ticket = await prisma.ticket.create({
        data: {
          projectId: testProjectId,
          symptomFileId: testFileId,
          title: 'False Positive Bug',
          description: 'Not a real issue',
          severity: Severity.low,
          confidence: 0.3,
          status: 'triaged',
          scannerModel: 'qwen3:8b'
        }
      });

      const response = await app.inject({
        method: 'POST',
        url: `/tickets/${ticket.id}/reject`,
        payload: { reason: 'False positive, works as intended' }
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.body);
      expect(json.ticket.status).toBe('rejected');

      const dbTicket = await prisma.ticket.findUnique({
        where: { id: ticket.id }
      });
      expect(dbTicket?.status).toBe('rejected');

      // Verify audit log
      const audit = await prisma.auditLog.findFirst({
        where: { ticketId: ticket.id, action: 'rejected' }
      });
      expect(audit).not.toBeNull();
    });

    it('invalid transition: should return 409 when rejecting an already rejected ticket', async () => {
      const ticket = await prisma.ticket.create({
        data: {
          projectId: testProjectId,
          symptomFileId: testFileId,
          title: 'Already Rejected Bug',
          description: 'desc',
          severity: Severity.low,
          confidence: 0.2,
          status: 'rejected',
          scannerModel: 'qwen3:8b'
        }
      });

      const response = await app.inject({
        method: 'POST',
        url: `/tickets/${ticket.id}/reject`
      });

      expect(response.statusCode).toBe(409);
      const json = JSON.parse(response.body);
      expect(json.error).toBe('Conflict');
    });
  });

  describe('Patch Routes', () => {
    it('should get patch and handle approve / reject transitions', async () => {
      const ticket = await prisma.ticket.create({
        data: {
          projectId: testProjectId,
          symptomFileId: testFileId,
          title: 'Ticket with Patch',
          description: 'desc',
          severity: Severity.medium,
          confidence: 0.8,
          status: 'awaiting_human',
          scannerModel: 'qwen3:8b'
        }
      });

      const patch = await prisma.patch.create({
        data: {
          ticketId: ticket.id,
          branchName: 'fix/patch-01',
          diff: '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new',
          rationale: 'Fix null pointer check',
          status: 'awaiting_review',
          fixerModel: 'qwen3-coder:30b'
        }
      });

      // GET /tickets/:id/patch
      const patchRes = await app.inject({
        method: 'GET',
        url: `/tickets/${ticket.id}/patch`
      });
      expect(patchRes.statusCode).toBe(200);
      const patchJson = JSON.parse(patchRes.body);
      expect(patchJson.id).toBe(patch.id);

      // POST /patches/:id/approve
      const approveRes = await app.inject({
        method: 'POST',
        url: `/patches/${patch.id}/approve`
      });
      expect(approveRes.statusCode).toBe(200);
      const approvedJson = JSON.parse(approveRes.body);
      expect(approvedJson.patch.status).toBe('approved');

      // Invalid transition: approving an already approved patch should return 409
      const reApproveRes = await app.inject({
        method: 'POST',
        url: `/patches/${patch.id}/approve`
      });
      expect(reApproveRes.statusCode).toBe(409);
    });

    it('should return all council review rows and final verdict row for a patch via GET /patches/:id/reviews and GET /tickets/:id/reviews', async () => {
      const ticket = await prisma.ticket.create({
        data: {
          projectId: testProjectId,
          symptomFileId: testFileId,
          title: 'Disputed Council Ticket',
          description: 'Council was split 1-1',
          severity: Severity.high,
          confidence: 0.85,
          status: 'awaiting_human_dispute',
          scannerModel: 'qwen3:8b'
        }
      });

      const patch = await prisma.patch.create({
        data: {
          ticketId: ticket.id,
          branchName: 'fix/council-dispute-01',
          diff: '--- a/index.ts\n+++ b/index.ts\n@@ -1 +1 @@\n-old\n+new',
          rationale: 'Council split debate test patch',
          status: 'awaiting_review',
          fixerModel: 'qwen3-coder:30b'
        }
      });

      // Insert 2 individual council members and 1 aggregated final verdict row
      await prisma.review.createMany({
        data: [
          {
            patchId: patch.id,
            verdict: 'pass',
            notes: 'Council Member 0 approved patch: looks clean and safe',
            reviewerModel: 'qwen3-coder:30b',
            council_member: 0,
            is_final_verdict: false
          },
          {
            patchId: patch.id,
            verdict: 'fail',
            notes: 'Council Member 1 rejected patch: potential edge case regression',
            reviewerModel: 'devstral:24b',
            council_member: 1,
            is_final_verdict: false
          },
          {
            patchId: patch.id,
            verdict: 'disputed',
            notes: 'Council deliberation resulted in a tie (1 pass, 1 fail). Human adjudication required.',
            reviewerModel: 'council-aggregate',
            council_member: null,
            is_final_verdict: true
          }
        ]
      });

      // 1. GET /patches/:id/reviews
      const patchReviewsRes = await app.inject({
        method: 'GET',
        url: `/patches/${patch.id}/reviews`
      });
      expect(patchReviewsRes.statusCode).toBe(200);
      const patchReviews = JSON.parse(patchReviewsRes.body);
      expect(patchReviews.length).toBe(3);

      // Verify individual members
      const member0 = patchReviews.find((r: any) => r.council_member === 0);
      expect(member0).toBeDefined();
      expect(member0.reviewerModel).toBe('qwen3-coder:30b');
      expect(member0.verdict).toBe('pass');
      expect(member0.is_final_verdict).toBe(false);
      expect(member0.notes).toContain('Council Member 0 approved');

      const member1 = patchReviews.find((r: any) => r.council_member === 1);
      expect(member1).toBeDefined();
      expect(member1.reviewerModel).toBe('devstral:24b');
      expect(member1.verdict).toBe('fail');
      expect(member1.is_final_verdict).toBe(false);
      expect(member1.notes).toContain('Council Member 1 rejected');

      // Verify final aggregated row
      const finalVerdict = patchReviews.find((r: any) => r.is_final_verdict === true);
      expect(finalVerdict).toBeDefined();
      expect(finalVerdict.verdict).toBe('disputed');
      expect(finalVerdict.notes).toContain('Human adjudication required');

      // 2. GET /tickets/:id/reviews
      const ticketReviewsRes = await app.inject({
        method: 'GET',
        url: `/tickets/${ticket.id}/reviews`
      });
      expect(ticketReviewsRes.statusCode).toBe(200);
      const ticketReviews = JSON.parse(ticketReviewsRes.body);
      expect(ticketReviews.length).toBe(3);

      // 3. 404 for non-existent patch
      const notFoundRes = await app.inject({
        method: 'GET',
        url: '/patches/non-existent-patch-id/reviews'
      });
      expect(notFoundRes.statusCode).toBe(404);
    });
  });
});
