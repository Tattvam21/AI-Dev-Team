import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { prisma as defaultPrisma, PrismaClient, Severity, Ticket } from '@ai-dev-team/db';
import { generateStructured } from '@ai-dev-team/llm-gateway';
import { loadPrompt } from '@ai-dev-team/llm-gateway';
import { GraphBuilder, getNeighbors } from '@ai-dev-team/dependency-graph';
import { getImpactedSet, syncProjectScanCache } from '@ai-dev-team/scan-cache';
import { runStaticAnalysis } from './static-analysis.js';

export const ScannerTicketSchema = z.object({
  title: z.string(),
  description: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  confidence: z.number(),
  rootCauseFile: z.string().nullable()
});

export type ScannerTicketOutput = z.infer<typeof ScannerTicketSchema>;

export interface ScanProgress {
  stage: 'graph' | 'impacted' | 'scanning' | 'static_analysis' | 'llm_analysis' | 'triage' | 'completed' | 'error';
  current: number;
  total: number;
  currentFile?: string;
  message: string;
}

export interface RunScanOptions {
  prisma?: PrismaClient;
  model?: string;
  llmClient?: any;
  promptVersion?: string;
  timeoutMs?: number;
  onProgress?: (progress: ScanProgress) => void;
}

/**
 * Runs the Scanner Agent for a given project:
 * 1. Discovers and indexes files in the project.
 * 2. Gets the impacted set (changed files + dependents).
 * 3. Runs static analysis (ESLint) and converts findings directly to Tickets.
 * 4. For files without static findings, calls the local LLM with 1-hop dependency context.
 * 5. Updates ScanCache and returns all created Tickets.
 */
export async function runScan(
  projectId: string,
  options: RunScanOptions = {}
): Promise<Ticket[]> {
  const prisma = options.prisma ?? defaultPrisma;
  const scannerModel =
    options.model ?? process.env.SCANNER_MODEL ?? 'llama3:latest';

  const project = await prisma.project.findUnique({
    where: { id: projectId }
  });

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const projectRoot = path.resolve(project.localPath ?? process.cwd());

  options.onProgress?.({
    stage: 'graph',
    current: 0,
    total: 100,
    message: 'Analyzing dependency graph and indexing project files...'
  });

  // Ensure graph and files exist in DB
  const graphBuilder = new GraphBuilder(projectId, projectRoot, { prisma });
  await graphBuilder.build();

  options.onProgress?.({
    stage: 'impacted',
    current: 10,
    total: 100,
    message: 'Calculating impacted files set...'
  });

  // Determine impacted files (or all files if first scan)
  let impactedRelativePaths = await getImpactedSet(projectId, { prisma });
  if (impactedRelativePaths.length === 0) {

    const allFiles = await prisma.file.findMany({
      where: { projectId },
      select: { path: true }
    });
    impactedRelativePaths = allFiles.map((f) => f.path);
  }

  const projectFiles = await prisma.file.findMany({
    where: { projectId }
  });

  const pathToRecord = new Map<string, typeof projectFiles[0]>();
  for (const f of projectFiles) {
    pathToRecord.set(f.path, f);
    const abs = path.resolve(projectRoot, f.path);
    pathToRecord.set(abs, f);
  }

  const createdTickets: Ticket[] = [];
  const scannedRelativePaths: string[] = [];

  // Helper to filter out vendor directories, build artifacts, typings and configs
  const filterScannable = (paths: string[]) =>
    paths.filter((relPath) => {
      const isVendorOrArtifact =
        relPath.includes('node_modules') ||
        relPath.includes('/dist/') ||
        relPath.includes('/build/') ||
        relPath.includes('/.next/') ||
        relPath.endsWith('.d.ts');
      if (isVendorOrArtifact) return false;

      const isConfigFile = /^(eslint|vite|vitest|tsconfig|rollup|webpack|postcss|tailwind)\.config\./i.test(
        path.basename(relPath)
      );
      return !isConfigFile;
    });

  let scannablePaths = filterScannable(impactedRelativePaths);
  if (scannablePaths.length === 0) {
    const allFiles = await prisma.file.findMany({
      where: { projectId },
      select: { path: true }
    });
    scannablePaths = filterScannable(allFiles.map((f) => f.path));
  }

  const totalFiles = scannablePaths.length;

  if (totalFiles === 0) {
    options.onProgress?.({
      stage: 'completed',
      current: 0,
      total: 0,
      message: 'No scannable JavaScript/TypeScript source files found in project.'
    });
    return [];
  }

  for (let i = 0; i < totalFiles; i++) {
    const relPath = scannablePaths[i];
    const fileIndex = i + 1;
    const fileRecord = pathToRecord.get(relPath);
    if (!fileRecord) continue;

    const absPath = path.resolve(projectRoot, relPath);
    if (!fs.existsSync(absPath)) continue;

    options.onProgress?.({
      stage: 'scanning',
      current: fileIndex,
      total: totalFiles,
      currentFile: relPath,
      message: `Analyzing file ${fileIndex} of ${totalFiles}: ${relPath}`
    });

    scannedRelativePaths.push(relPath);

    // 1. Run static analysis
    const lintFindings = await runStaticAnalysis([absPath], {
      cwd: projectRoot,
      warnOnMissingConfig: false
    });


    if (lintFindings.length > 0) {
      for (const finding of lintFindings) {
        const severity: Severity =
          finding.severity === 'error' ? Severity.high : Severity.medium;

        const ticket = await prisma.ticket.create({
          data: {
            projectId,
            symptomFileId: fileRecord.id,
            rootCauseFileId: fileRecord.id,
            lineStart: finding.line,
            lineEnd: finding.line,
            title: finding.ruleId
              ? `[ESLint: ${finding.ruleId}] ${finding.message}`
              : finding.message,
            description: finding.message,
            severity,
            confidence: 1.0,
            status: 'found',
            scannerModel: 'eslint'
          }
        });
        createdTickets.push(ticket);
      }
      // Continue to next file; static analysis found issues
      continue;
    }

    // 2. For files without static findings, run LLM pass with 1-hop context
    const fileContent = fs.readFileSync(absPath, 'utf-8');

    // 1-Hop Neighbor Discovery
    const neighborIds = await getNeighbors(fileRecord.id, 1, prisma);
    const neighborFiles = await prisma.file.findMany({
      where: { id: { in: neighborIds } }
    });

    const [outgoingEdges, incomingEdges] = await Promise.all([
      prisma.fileEdge.findMany({
        where: { fromFileId: fileRecord.id },
        include: { toFile: true }
      }),
      prisma.fileEdge.findMany({
        where: { toFileId: fileRecord.id },
        include: { fromFile: true }
      })
    ]);

    const dependenciesList =
      outgoingEdges.length > 0
        ? outgoingEdges.map((e) => `- ${e.toFile.path}`).join('\n')
        : 'None';

    const callersList =
      incomingEdges.length > 0
        ? incomingEdges.map((e) => `- ${e.fromFile.path}`).join('\n')
        : 'None';

    // Neighbor file snippets for context
    const neighborSnippets = neighborFiles
      .map((nf) => {
        const nfAbs = path.resolve(projectRoot, nf.path);
        if (fs.existsSync(nfAbs)) {
          const content = fs.readFileSync(nfAbs, 'utf-8');
          return `// File: ${nf.path}\n${content.slice(0, 1000)}`;
        }
        return `// File: ${nf.path} (content unavailable)`;
      })
      .join('\n\n');

    const promptText = loadPrompt('scanner', 'latest', {
      filePath: relPath,
      fileContent,
      dependencies: `${dependenciesList}\n\nConnected Context:\n${neighborSnippets}`,
      callers: callersList
    });

    const scannerTimeout =
      options.timeoutMs ??
      (process.env.SCANNER_TIMEOUT_MS ? parseInt(process.env.SCANNER_TIMEOUT_MS, 10) : 60000);

    options.onProgress?.({
      stage: 'llm_analysis',
      current: fileIndex,
      total: totalFiles,
      currentFile: relPath,
      message: `Running LLM deep inspection on ${relPath} (${fileIndex}/${totalFiles})...`
    });

    try {
      const llmOutput = await generateStructured<ScannerTicketOutput>({

        model: scannerModel,
        systemPrompt: promptText,
        userPrompt: `Scan file '${relPath}' for logic bugs, unhandled null exceptions, or contract mismatches.`,
        schema: ScannerTicketSchema,
        client: options.llmClient,
        promptVersion: options.promptVersion ?? 'scanner/v1',
        timeoutMs: scannerTimeout
      });

      // Filter out outputs that explicitly state no bug found or zero confidence
      const lowerTitle = llmOutput.title.toLowerCase();
      const isClean =
        llmOutput.confidence < 0.3 ||
        lowerTitle.includes('no bug') ||
        lowerTitle.includes('no issue') ||
        lowerTitle.includes('clean');

      if (!isClean) {
        // Resolve root cause file
        let rootCauseFileId = fileRecord.id;
        if (llmOutput.rootCauseFile) {
          const matched = pathToRecord.get(llmOutput.rootCauseFile);
          if (matched) {
            rootCauseFileId = matched.id;
          }
        }

        // Create Ticket
        const ticket = await prisma.ticket.create({
          data: {
            projectId,
            symptomFileId: fileRecord.id,
            rootCauseFileId,
            title: llmOutput.title,
            description: llmOutput.description,
            severity: llmOutput.severity as Severity,
            confidence: llmOutput.confidence,
            scannerModel
          }
        });

        createdTickets.push(ticket);
      }
    } catch (err: any) {
      console.error(`[ScannerAgent] Error scanning file '${relPath}':`, err?.message || err);
      await prisma.auditLog.create({
        data: {
          actor: 'scanner-agent',
          action: err.name === 'LLMTimeoutError' ? 'scan_timeout' : 'scan_error',
          details: {
            file: relPath,
            error: err.message,
            model: scannerModel,
            timeoutMs: scannerTimeout
          }
        }
      }).catch(() => {});
    }
  }

  // 5. Update ScanCache
  if (scannedRelativePaths.length > 0) {
    await syncProjectScanCache(projectId, scannedRelativePaths, prisma);
  }

  options.onProgress?.({
    stage: 'completed',
    current: totalFiles,
    total: totalFiles,
    message: `Scanner completed: ${createdTickets.length} issue(s) identified across ${totalFiles} file(s).`
  });

  return createdTickets;
}

