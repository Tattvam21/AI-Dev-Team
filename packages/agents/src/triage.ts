import { prisma as defaultPrisma, PrismaClient, Severity, Ticket } from '@ai-dev-team/db';
import { generateStructured, loadPrompt } from '@ai-dev-team/llm-gateway';
import { z } from 'zod';

export const TriagedTicketSchema = z.object({
  id: z.string().describe('The ID of the ticket being evaluated'),
  severity: z
    .enum(['critical', 'high', 'medium', 'low'])
    .optional()
    .describe('Re-scored severity level'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Re-scored confidence score between 0.0 and 1.0'),
  reasoning: z
    .string()
    .optional()
    .describe('Reasoning for score adjustments or verification notes')
});

export const TriageBatchSchema = z.object({
  tickets: z.array(TriagedTicketSchema).describe('Batch of triaged tickets')
});

export type TriageBatchOutput = z.infer<typeof TriageBatchSchema>;

export interface RunTriageOptions {
  prisma?: PrismaClient;
  model?: string;
  llmClient?: any;
  promptVersion?: string;
  timeoutMs?: number;
}

/**
 * Determines whether two tickets on the same file have overlapping line ranges.
 */
export function linesOverlap(
  a: { lineStart: number | null; lineEnd: number | null },
  b: { lineStart: number | null; lineEnd: number | null }
): boolean {
  const aHasLines = a.lineStart !== null && a.lineStart !== undefined;
  const bHasLines = b.lineStart !== null && b.lineStart !== undefined;

  // Both have no line numbers specified -> same file-level defect
  if (!aHasLines && !bHasLines) {
    return true;
  }

  // One specifies exact lines and one is file-level -> do not group as overlapping lines
  if (!aHasLines || !bHasLines) {
    return false;
  }

  const aStart = a.lineStart!;
  const aEnd = a.lineEnd ?? a.lineStart!;
  const bStart = b.lineStart!;
  const bEnd = b.lineEnd ?? b.lineStart!;

  return Math.max(aStart, bStart) <= Math.min(aEnd, bEnd);
}

export type TicketWithSymptom = Ticket & {
  symptomFile?: { path: string } | null;
};

/**
 * Groups tickets pointing at the same file and overlapping line range as duplicates.
 * Preserves the single highest-confidence ticket in each cluster as the survivor.
 * The rest are flagged as duplicates.
 */
export function partitionDuplicateTickets<T extends Ticket>(tickets: T[]): {
  survivors: T[];
  duplicates: T[];
} {
  // Group tickets by symptomFileId
  const byFile = new Map<string, T[]>();
  for (const t of tickets) {
    const list = byFile.get(t.symptomFileId) ?? [];
    list.push(t);
    byFile.set(t.symptomFileId, list);
  }

  const survivors: T[] = [];
  const duplicates: T[] = [];

  for (const fileTickets of byFile.values()) {
    const n = fileTickets.length;
    if (n === 1) {
      survivors.push(fileTickets[0]);
      continue;
    }

    // Connected components via Union-Find
    const parent = Array.from({ length: n }, (_, i) => i);
    function find(i: number): number {
      if (parent[i] === i) return i;
      parent[i] = find(parent[i]);
      return parent[i];
    }
    function union(i: number, j: number) {
      const rootI = find(i);
      const rootJ = find(j);
      if (rootI !== rootJ) parent[rootI] = rootJ;
    }

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (linesOverlap(fileTickets[i], fileTickets[j])) {
          union(i, j);
        }
      }
    }

    const clusters = new Map<number, T[]>();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      const cluster = clusters.get(root) ?? [];
      cluster.push(fileTickets[i]);
      clusters.set(root, cluster);
    }

    for (const cluster of clusters.values()) {
      if (cluster.length === 1) {
        survivors.push(cluster[0]);
      } else {
        // Sort descending by confidence, tie-break by ID
        cluster.sort((a, b) => {
          if (b.confidence !== a.confidence) {
            return b.confidence - a.confidence;
          }
          return a.id.localeCompare(b.id);
        });

        survivors.push(cluster[0]);
        for (let k = 1; k < cluster.length; k++) {
          duplicates.push(cluster[k]);
        }
      }
    }
  }

  return { survivors, duplicates };
}

/**
 * Runs the Triage Agent on a project:
 * 1. Groups tickets pointing at the same file + overlapping line range as duplicates,
 *    keeping the highest-confidence one and marking the rest status 'merged_duplicate'.
 * 2. For remaining tickets, calls the LLM (triage prompt) to re-score severity/confidence.
 * 3. Sets status to 'triaged' on all surviving tickets.
 */
export async function runTriage(
  projectId: string,
  options: RunTriageOptions = {}
): Promise<void> {
  const prisma = options.prisma ?? defaultPrisma;
  const triageModel =
    options.model ??
    process.env.TRIAGE_MODEL ??
    process.env.MODEL_TRIAGE ??
    'llama3:latest';

  // 1. Fetch all tickets with status 'found' for the project
  const foundTickets = await prisma.ticket.findMany({
    where: {
      projectId,
      status: 'found'
    },
    include: {
      symptomFile: true
    }
  });

  if (foundTickets.length === 0) {
    return;
  }

  // Group tickets into survivors and duplicates
  const { survivors, duplicates } = partitionDuplicateTickets(foundTickets);

  // Mark duplicate tickets as 'merged_duplicate'
  if (duplicates.length > 0) {
    await prisma.ticket.updateMany({
      where: {
        id: { in: duplicates.map((d) => d.id) }
      },
      data: {
        status: 'merged_duplicate'
      }
    });
  }

  // 2. Call the LLM for remaining surviving tickets to re-score severity and confidence
  if (survivors.length > 0) {
    const BATCH_SIZE = 10;
    for (let i = 0; i < survivors.length; i += BATCH_SIZE) {
      const batch = survivors.slice(i, i + BATCH_SIZE);
      const ticketSummaries = batch.map((t) => ({
        id: t.id,
        file: t.symptomFile?.path ?? t.symptomFileId,
        lineStart: t.lineStart,
        lineEnd: t.lineEnd,
        title: t.title,
        description: t.description,
        severity: t.severity,
        confidence: t.confidence
      }));

      const systemPrompt = loadPrompt('triage', options.promptVersion ?? 'latest', {
        tickets: JSON.stringify(ticketSummaries, null, 2)
      });

      const triageTimeout =
        options.timeoutMs ??
        (process.env.TRIAGE_TIMEOUT_MS ? parseInt(process.env.TRIAGE_TIMEOUT_MS, 10) : 60000);

      try {
        const triageOutput = await generateStructured<TriageBatchOutput>({
          model: triageModel,
          systemPrompt,
          userPrompt: `Review and calibrate severity and confidence scores for this batch of ${batch.length} ticket(s).`,
          schema: TriageBatchSchema,
          client: options.llmClient,
          promptVersion: options.promptVersion ?? 'triage/v1',
          timeoutMs: triageTimeout
        });

        if (triageOutput?.tickets) {
          for (const item of triageOutput.tickets) {
            const updateData: { severity?: Severity; confidence?: number } = {};
            if (
              item.severity &&
              Object.values(Severity).includes(item.severity as Severity)
            ) {
              updateData.severity = item.severity as Severity;
            }
            if (typeof item.confidence === 'number' && !isNaN(item.confidence)) {
              updateData.confidence = Math.max(0, Math.min(1, item.confidence));
            }

            if (Object.keys(updateData).length > 0) {
              await prisma.ticket.update({
                where: { id: item.id },
                data: updateData
              });
            }
          }
        }
      } catch (err: any) {
        console.warn('[Triage] LLM re-scoring failed, keeping existing scores:', err);
        for (const ticket of batch) {
          await prisma.auditLog.create({
            data: {
              ticketId: ticket.id,
              actor: 'triage-agent',
              action: err.name === 'LLMTimeoutError' ? 'triage_timeout' : 'triage_warning',
              details: {
                error: err.message,
                model: triageModel,
                timeoutMs: triageTimeout
              }
            }
          }).catch(() => {});
        }
      }
    }

    // 3. Set status to 'triaged' on all surviving tickets
    await prisma.ticket.updateMany({
      where: {
        id: { in: survivors.map((s) => s.id) }
      },
      data: {
        status: 'triaged'
      }
    });
  }
}
