export type TicketSeverity = 'critical' | 'high' | 'medium' | 'low';

export type TicketStatus =
  | 'found'
  | 'triaged'
  | 'approved'
  | 'fixing'
  | 'in_review'
  | 'approved_by_reviewer'
  | 'awaiting_human'
  | 'awaiting_human_dispute'
  | 'pushed'
  | 'merged'
  | 'rejected'
  | 'merged_duplicate'
  | string;

export interface FileReference {
  id: string;
  path: string;
}

export interface Ticket {
  id: string;
  projectId: string;
  symptomFileId: string;
  symptomFile?: FileReference | null;
  rootCauseFileId?: string | null;
  rootCauseFile?: FileReference | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  title: string;
  description: string;
  severity: TicketSeverity;
  confidence: number;
  status: TicketStatus;
  scannerModel: string;
  createdAt: string;
  updatedAt: string;
}

export interface Review {
  id: string;
  patchId: string;
  verdict: 'pass' | 'fail' | 'disputed';
  notes?: string | null;
  reviewerModel: string;
  reviewedAt: string;
  council_member?: number | null;
  is_final_verdict: boolean;
}

export interface Project {
  id: string;
  name: string;
  localPath?: string | null;
  githubRepo?: string | null;
  createdAt: string;
}
