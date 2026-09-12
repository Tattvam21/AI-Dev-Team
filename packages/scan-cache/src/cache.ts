import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { prisma as defaultPrisma, PrismaClient } from '@ai-dev-team/db';
import { getNeighbors } from '@ai-dev-team/dependency-graph';

export interface CacheOptions {
  prisma?: PrismaClient;
  hops?: number;
}

/**
 * Computes SHA-256 content hash for a file.
 */
export function computeContentHash(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Compares current file hashes on disk against ScanCache records to find changed files.
 */
export async function findChangedFiles(
  projectId: string,
  prisma: PrismaClient = defaultPrisma
): Promise<Array<{ id: string; path: string; currentHash: string }>> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      files: {
        include: {
          scanCache: true
        }
      }
    }
  });

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const projectRoot = project.localPath ?? process.cwd();
  const changed: Array<{ id: string; path: string; currentHash: string }> = [];

  for (const file of project.files) {
    const absPath = path.isAbsolute(file.path) ? file.path : path.join(projectRoot, file.path);
    if (!fs.existsSync(absPath)) {
      continue;
    }

    const currentHash = computeContentHash(absPath);
    const cachedHash = file.scanCache?.contentHash;

    if (!cachedHash || cachedHash !== currentHash) {
      changed.push({
        id: file.id,
        path: file.path,
        currentHash
      });
    }
  }

  return changed;
}

/**
 * Computes the full impacted set: changed files plus any files that depend on them (or 1-hop neighbors).
 */
export async function getImpactedSet(
  projectId: string,
  options: CacheOptions = {}
): Promise<string[]> {
  const prisma = options.prisma ?? defaultPrisma;
  const hops = options.hops ?? 1;

  const changedFiles = await findChangedFiles(projectId, prisma);
  if (changedFiles.length === 0) {
    return [];
  }

  const impactedFileIds = new Set<string>();
  const idToPath = new Map<string, string>();

  // Fetch all files in the project to map id -> path
  const allFiles = await prisma.file.findMany({
    where: { projectId },
    select: { id: true, path: true }
  });

  for (const f of allFiles) {
    idToPath.set(f.id, f.path);
  }

  for (const changed of changedFiles) {
    impactedFileIds.add(changed.id);

    // Expand to dependents / neighbors using getNeighbors
    const neighbors = await getNeighbors(changed.id, hops, prisma);
    for (const neighborId of neighbors) {
      impactedFileIds.add(neighborId);
    }
  }

  const impactedPaths: string[] = [];
  for (const id of impactedFileIds) {
    const p = idToPath.get(id);
    if (p) {
      impactedPaths.push(p);
    }
  }

  return impactedPaths;
}

/**
 * Updates ScanCache row after a successful scan.
 */
export async function updateScanCache(
  fileId: string,
  contentHash: string,
  dependencyHashes: Record<string, string> = {},
  cachedTicketIds: string[] = [],
  prisma: PrismaClient = defaultPrisma
): Promise<void> {
  await prisma.scanCache.upsert({
    where: { fileId },
    create: {
      fileId,
      contentHash,
      dependencyHashes,
      cachedTicketIds,
      lastScannedAt: new Date()
    },
    update: {
      contentHash,
      dependencyHashes,
      cachedTicketIds,
      lastScannedAt: new Date()
    }
  });

  await prisma.file.update({
    where: { id: fileId },
    data: {
      contentHash,
      lastScannedAt: new Date()
    }
  });
}

/**
 * Batch updates ScanCache rows for all scanned files in a project.
 */
export async function syncProjectScanCache(
  projectId: string,
  scannedFilePaths: string[],
  prisma: PrismaClient = defaultPrisma
): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      files: {
        where: { path: { in: scannedFilePaths } }
      }
    }
  });

  if (!project) return;
  const projectRoot = project.localPath ?? process.cwd();

  for (const file of project.files) {
    const absPath = path.isAbsolute(file.path) ? file.path : path.join(projectRoot, file.path);
    if (fs.existsSync(absPath)) {
      const hash = computeContentHash(absPath);
      await updateScanCache(file.id, hash, {}, [], prisma);
    }
  }
}
