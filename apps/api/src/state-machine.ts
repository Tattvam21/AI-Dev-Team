import { prisma as defaultPrisma, PrismaClient, Ticket, AuditLog } from '@ai-dev-team/db';
import { broadcastTicketEvent } from './ws.js';

export class InvalidStateTransitionError extends Error {
  readonly statusCode = 409;
  readonly entityType: 'ticket' | 'patch';
  readonly fromStatus: string;
  readonly toStatus: string;

  constructor(
    entityType: 'ticket' | 'patch',
    fromStatus: string,
    toStatus: string,
    message?: string
  ) {
    super(
      message ??
        `Invalid ${entityType} state transition: cannot transition from '${fromStatus}' to '${toStatus}'.`
    );
    this.name = 'InvalidStateTransitionError';
    this.entityType = entityType;
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

/**
 * Valid transitions for Ticket statuses.
 */
export const TICKET_STATE_TRANSITIONS: Record<string, string[]> = {
  found: ['triaged', 'triage_timeout', 'triage_failed', 'merged_duplicate', 'rejected'],
  triaged: ['approved', 'rejected'],
  approved: ['fixing', 'fix_timeout', 'fix_failed', 'rejected'],
  fixing: [
    'in_review',
    'fix_timeout',
    'fix_failed',
    'fix_apply_failed',
    'failed_needs_human',
    'failed',
    'rejected'
  ],
  in_review: [
    'in_review',
    'awaiting_human',
    'awaiting_human_dispute',
    'test_writer_timeout',
    'test_writer_failed',
    'sandbox_timeout',
    'sandbox_failed',
    'reviewer_timeout',
    'reviewer_failed',
    'failed_needs_human',
    'approved_by_reviewer',
    'fixing',
    'rejected',
    'failed'
  ],
  approved_by_reviewer: ['awaiting_human', 'awaiting_human_dispute', 'rejected'],
  awaiting_human: ['pushed', 'fixing', 'rejected', 'approved'],
  awaiting_human_dispute: ['pushed', 'fixing', 'rejected', 'approved'],
  failed_needs_human: ['approved', 'fixing', 'rejected'],
  fix_timeout: ['approved', 'fixing', 'rejected', 'failed_needs_human'],
  fix_failed: ['approved', 'fixing', 'rejected', 'failed_needs_human'],
  fix_apply_failed: ['approved', 'fixing', 'rejected', 'failed_needs_human'],
  test_writer_timeout: ['fixing', 'rejected', 'failed_needs_human'],
  test_writer_failed: ['fixing', 'rejected', 'failed_needs_human'],
  sandbox_timeout: ['fixing', 'rejected', 'failed_needs_human'],
  sandbox_failed: ['fixing', 'rejected', 'failed_needs_human'],
  reviewer_timeout: ['fixing', 'rejected', 'failed_needs_human'],
  reviewer_failed: ['fixing', 'rejected', 'failed_needs_human'],
  triage_timeout: ['triaged', 'rejected'],
  triage_failed: ['triaged', 'rejected'],
  pushed: ['merged', 'failed', 'rejected'],
  failed: ['fixing', 'rejected'],
  rejected: [],
  merged: [],
  merged_duplicate: []
};

/**
 * Valid transitions for Patch statuses.
 */
export const PATCH_STATE_TRANSITIONS: Record<string, string[]> = {
  awaiting_review: ['approved', 'rejected', 'in_review', 'failed_timeout', 'failed_apply'],
  in_review: ['approved', 'rejected', 'awaiting_review', 'failed_timeout'],
  approved: ['ready_to_push', 'pushed', 'rejected', 'failed_conflict'],
  ready_to_push: ['pushed', 'failed_conflict', 'push_failed', 'rejected'],
  failed_conflict: ['ready_to_push', 'rejected'],
  push_failed: ['ready_to_push', 'rejected'],
  failed_timeout: ['awaiting_review', 'rejected'],
  failed_apply: ['awaiting_review', 'rejected'],
  rejected: ['awaiting_review'],
  pushed: []
};

export function canTransitionTicket(fromStatus: string, toStatus: string): boolean {
  const allowed = TICKET_STATE_TRANSITIONS[fromStatus] || [];
  return allowed.includes(toStatus);
}

export function validateTicketTransition(fromStatus: string, toStatus: string): void {
  if (!canTransitionTicket(fromStatus, toStatus)) {
    throw new InvalidStateTransitionError('ticket', fromStatus, toStatus);
  }
}

export function canTransitionPatch(fromStatus: string, toStatus: string): boolean {
  const allowed = PATCH_STATE_TRANSITIONS[fromStatus] || [];
  return allowed.includes(toStatus);
}

export function validatePatchTransition(fromStatus: string, toStatus: string): void {
  if (!canTransitionPatch(fromStatus, toStatus)) {
    throw new InvalidStateTransitionError('patch', fromStatus, toStatus);
  }
}

export interface TransitionTicketOptions {
  actor: string;
  action?: string;
  details?: Record<string, any>;
  prisma?: PrismaClient;
  additionalData?: Partial<Ticket>;
}

/**
 * Central state transition function for tickets:
 * 1. Validates the state transition against TICKET_STATE_TRANSITIONS
 * 2. Updates the Ticket row in the database
 * 3. Centrally creates an AuditLog row recording actor, action, and details
 * 4. Broadcasts a ticket_updated event via WebSocket to all clients subscribed to the project
 */
export async function transitionTicket(
  ticketId: string,
  toStatus: string,
  options: TransitionTicketOptions
): Promise<{ ticket: Ticket; auditLog: AuditLog }> {
  const prisma = options.prisma ?? defaultPrisma;

  const currentTicket = await prisma.ticket.findUnique({
    where: { id: ticketId }
  });

  if (!currentTicket) {
    throw new Error(`Ticket with id '${ticketId}' not found`);
  }

  // Validate state machine transition
  validateTicketTransition(currentTicket.status, toStatus);

  // Update Ticket status and any extra fields (e.g. retryCount)
  const updatedTicket = await prisma.ticket.update({
    where: { id: ticketId },
    data: {
      status: toStatus,
      ...(options.additionalData || {})
    }
  });

  // Action name: explicit action or defaults to toStatus
  const actionName = options.action ?? toStatus;

  // Single central place to create AuditLog
  const auditDetails = {
    previousStatus: currentTicket.status,
    newStatus: toStatus,
    ...(options.details || {})
  };

  const auditLog = await prisma.auditLog.create({
    data: {
      ticketId: updatedTicket.id,
      actor: options.actor,
      action: actionName,
      details: auditDetails
    }
  });

  // Broadcast ticket state change event via WebSocket to connected project subscribers
  try {
    broadcastTicketEvent(updatedTicket.projectId, {
      type: 'ticket_updated',
      ticketId: updatedTicket.id,
      projectId: updatedTicket.projectId,
      status: updatedTicket.status,
      actor: options.actor,
      ticket: updatedTicket,
      audit: auditLog,
      timestamp: new Date().toISOString()
    });
  } catch {
    // Non-blocking if websocket broadcast encounters any issue
  }

  return { ticket: updatedTicket, auditLog };
}
