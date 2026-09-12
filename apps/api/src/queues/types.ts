export interface ScanJobData {
  projectId: string;
}

export interface FixerJobData {
  ticketId: string;
  projectId?: string;
  reviewerNotes?: string;
}

export interface TestWriterJobData {
  patchId: string;
  ticketId: string;
  projectId?: string;
}

export interface SandboxJobData {
  patchId: string;
  ticketId: string;
  projectId?: string;
}

export interface ReviewerJobData {
  patchId: string;
  ticketId: string;
  projectId?: string;
}

export interface EnqueuedJobResult {
  id: string;
  name: string;
  queue: string;
  data: any;
  createdAt: Date;
}
