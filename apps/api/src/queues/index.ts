import { Queue, Worker } from 'bullmq';
import {
  ScanJobData,
  FixerJobData,
  TestWriterJobData,
  SandboxJobData,
  ReviewerJobData,
  EnqueuedJobResult
} from './types.js';
import {
  processScanJob,
  processFixerJob,
  processTestWriterJob,
  processSandboxJob,
  processReviewerJob
} from './approval-loop.js';

export * from './types.js';
export * from './approval-loop.js';

// In-memory queue storage for inspection and test environments
const inMemoryQueuedJobs: EnqueuedJobResult[] = [];

let scanQueue: Queue | null = null;
let fixerQueue: Queue | null = null;
let testWriterQueue: Queue | null = null;
let sandboxQueue: Queue | null = null;
let reviewerQueue: Queue | null = null;

let scanWorker: Worker | null = null;
let fixerWorker: Worker | null = null;
let testWriterWorker: Worker | null = null;
let sandboxWorker: Worker | null = null;
let reviewerWorker: Worker | null = null;


let bullMqInitialized = false;

function parseRedisConnection() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || 'localhost',
      port: parsed.port ? parseInt(parsed.port, 10) : 6379,
      password: parsed.password || undefined,
      maxRetriesPerRequest: null,
      enableOfflineQueue: false
    };
  } catch {
    return {
      host: 'localhost',
      port: 6379,
      maxRetriesPerRequest: null,
      enableOfflineQueue: false
    };
  }
}

export const DEFAULT_QUEUE_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 1000
  },
  removeOnComplete: 100,
  removeOnFail: 200
};

export function initBullMqQueues() {
  if (bullMqInitialized) return;
  bullMqInitialized = true;

  if (process.env.NODE_ENV === 'test' && !process.env.USE_REAL_REDIS) {
    return;
  }

  try {
    const connection = parseRedisConnection();
    scanQueue = new Queue('scan-queue', {
      connection,
      defaultJobOptions: DEFAULT_QUEUE_JOB_OPTIONS
    });
    fixerQueue = new Queue('fixer-queue', {
      connection,
      defaultJobOptions: DEFAULT_QUEUE_JOB_OPTIONS
    });
    testWriterQueue = new Queue('test-writer-queue', {
      connection,
      defaultJobOptions: DEFAULT_QUEUE_JOB_OPTIONS
    });
    sandboxQueue = new Queue('sandbox-queue', {
      connection,
      defaultJobOptions: DEFAULT_QUEUE_JOB_OPTIONS
    });
    reviewerQueue = new Queue('reviewer-queue', {
      connection,
      defaultJobOptions: DEFAULT_QUEUE_JOB_OPTIONS
    });
  } catch (err) {
    console.warn('[Queue] Failed to initialize BullMQ with Redis, falling back to memory queue:', err);
  }
}

export function startApprovalWorkers(options: any = {}) {
  if (process.env.NODE_ENV === 'test' && !process.env.USE_REAL_REDIS) {
    return;
  }

  try {
    const connection = parseRedisConnection();

    scanWorker = new Worker(
      'scan-queue',
      async (job) => {
        return processScanJob(job.data, options);
      },
      { connection }
    );

    fixerWorker = new Worker(
      'fixer-queue',
      async (job) => {
        return processFixerJob(job.data, options);
      },
      { connection }
    );


    testWriterWorker = new Worker(
      'test-writer-queue',
      async (job) => {
        return processTestWriterJob(job.data, options);
      },
      { connection }
    );

    sandboxWorker = new Worker(
      'sandbox-queue',
      async (job) => {
        return processSandboxJob(job.data, options);
      },
      { connection }
    );

    reviewerWorker = new Worker(
      'reviewer-queue',
      async (job) => {
        return processReviewerJob(job.data, options);
      },
      { connection }
    );
  } catch (err) {
    console.warn('[Queue] Failed to start BullMQ workers:', err);
  }
}

export async function enqueueScanJob(projectId: string): Promise<EnqueuedJobResult> {
  initBullMqQueues();

  const jobId = `scan-${projectId}-${Date.now()}`;
  const jobResult: EnqueuedJobResult = {
    id: jobId,
    name: 'scan-project',
    queue: 'scan-queue',
    data: { projectId },
    createdAt: new Date()
  };

  inMemoryQueuedJobs.push(jobResult);

  if (scanQueue) {
    try {
      const bullJob = await scanQueue.add('scan-project', { projectId }, { jobId });
      if (bullJob?.id) jobResult.id = String(bullJob.id);
    } catch (err) {
      console.warn('[Queue] BullMQ Redis enqueue failed, kept in-memory record:', err);
    }
  }

  return jobResult;
}

export async function enqueueFixerJob(
  ticketId: string,
  projectId: string,
  reviewerNotes?: string
): Promise<EnqueuedJobResult> {
  initBullMqQueues();

  const jobId = `fixer-${ticketId}-${Date.now()}`;
  const jobResult: EnqueuedJobResult = {
    id: jobId,
    name: 'fix-ticket',
    queue: 'fixer-queue',
    data: { ticketId, projectId, reviewerNotes },
    createdAt: new Date()
  };

  inMemoryQueuedJobs.push(jobResult);

  if (fixerQueue) {
    try {
      const bullJob = await fixerQueue.add(
        'fix-ticket',
        { ticketId, projectId, reviewerNotes },
        { jobId }
      );
      if (bullJob?.id) jobResult.id = String(bullJob.id);
    } catch (err) {
      console.warn('[Queue] BullMQ Redis enqueue failed, kept in-memory record:', err);
    }
  }

  return jobResult;
}

export async function enqueueTestWriterJob(
  patchId: string,
  ticketId: string,
  projectId?: string
): Promise<EnqueuedJobResult> {
  initBullMqQueues();

  const jobId = `testwriter-${patchId}-${Date.now()}`;
  const jobResult: EnqueuedJobResult = {
    id: jobId,
    name: 'write-tests',
    queue: 'test-writer-queue',
    data: { patchId, ticketId, projectId },
    createdAt: new Date()
  };

  inMemoryQueuedJobs.push(jobResult);

  if (testWriterQueue) {
    try {
      const bullJob = await testWriterQueue.add(
        'write-tests',
        { patchId, ticketId, projectId },
        { jobId }
      );
      if (bullJob?.id) jobResult.id = String(bullJob.id);
    } catch (err) {
      console.warn('[Queue] BullMQ Redis enqueue failed, kept in-memory record:', err);
    }
  }

  return jobResult;
}

export async function enqueueSandboxJob(
  patchId: string,
  ticketId: string,
  projectId?: string
): Promise<EnqueuedJobResult> {
  initBullMqQueues();

  const jobId = `sandbox-${patchId}-${Date.now()}`;
  const jobResult: EnqueuedJobResult = {
    id: jobId,
    name: 'run-sandbox',
    queue: 'sandbox-queue',
    data: { patchId, ticketId, projectId },
    createdAt: new Date()
  };

  inMemoryQueuedJobs.push(jobResult);

  if (sandboxQueue) {
    try {
      const bullJob = await sandboxQueue.add(
        'run-sandbox',
        { patchId, ticketId, projectId },
        { jobId }
      );
      if (bullJob?.id) jobResult.id = String(bullJob.id);
    } catch (err) {
      console.warn('[Queue] BullMQ Redis enqueue failed, kept in-memory record:', err);
    }
  }

  return jobResult;
}

export async function enqueueReviewerJob(
  patchId: string,
  ticketId: string,
  projectId?: string
): Promise<EnqueuedJobResult> {
  initBullMqQueues();

  const jobId = `reviewer-${patchId}-${Date.now()}`;
  const jobResult: EnqueuedJobResult = {
    id: jobId,
    name: 'review-patch',
    queue: 'reviewer-queue',
    data: { patchId, ticketId, projectId },
    createdAt: new Date()
  };

  inMemoryQueuedJobs.push(jobResult);

  if (reviewerQueue) {
    try {
      const bullJob = await reviewerQueue.add(
        'review-patch',
        { patchId, ticketId, projectId },
        { jobId }
      );
      if (bullJob?.id) jobResult.id = String(bullJob.id);
    } catch (err) {
      console.warn('[Queue] BullMQ Redis enqueue failed, kept in-memory record:', err);
    }
  }

  return jobResult;
}

export function getQueuedJobs(queueName?: string): EnqueuedJobResult[] {
  if (!queueName) {
    return [...inMemoryQueuedJobs];
  }
  return inMemoryQueuedJobs.filter((j) => j.queue === queueName);
}

export function clearQueuedJobs(): void {
  inMemoryQueuedJobs.length = 0;
}

export async function closeQueues(): Promise<void> {
  const queues = [scanQueue, fixerQueue, testWriterQueue, sandboxQueue, reviewerQueue];
  for (const q of queues) {
    if (q) await q.close().catch(() => {});
  }
  scanQueue = null;
  fixerQueue = null;
  testWriterQueue = null;
  sandboxQueue = null;
  reviewerQueue = null;

  const workers = [scanWorker, fixerWorker, testWriterWorker, sandboxWorker, reviewerWorker];
  for (const w of workers) {
    if (w) await w.close().catch(() => {});
  }
  scanWorker = null;
  fixerWorker = null;
  testWriterWorker = null;
  sandboxWorker = null;
  reviewerWorker = null;

  bullMqInitialized = false;

}
