import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import ignore from 'ignore';
import { prisma as defaultPrisma, PrismaClient, EdgeType } from '@ai-dev-team/db';
import { extractImports } from './parser.js';

export interface GraphBuilderOptions {
  prisma?: PrismaClient;
}

export class GraphBuilder {
  public readonly projectId: string;
  public readonly projectRoot: string;
  public readonly prisma: PrismaClient;

  constructor(projectId: string, projectRoot: string, options: GraphBuilderOptions = {}) {
    this.projectId = projectId;
    this.projectRoot = path.resolve(projectRoot);
    this.prisma = options.prisma ?? defaultPrisma;
  }

  /**
   * Calculates SHA-256 hash of file content.
   */
  private computeHash(filePath: string): string {
    const buffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * Discovers all JS/TS files in projectRoot respecting .gitignore.
   */
  public discoverFiles(): string[] {
    const ig = ignore();
    ig.add(['node_modules', '.git', 'dist', '.agents', '.planning', '.DS_Store']);

    const gitignorePath = path.join(this.projectRoot, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
      ig.add(gitignoreContent);
    }

    const files: string[] = [];
    const supportedExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

    const walk = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.name === 'node_modules' ||
          entry.name === '.git' ||
          entry.name === 'dist' ||
          entry.name === 'build' ||
          entry.name === '.next' ||
          entry.name.startsWith('.cache') ||
          entry.name.endsWith('.d.ts')
        ) {
          continue;
        }

        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(this.projectRoot, fullPath);

        if (ig.ignores(relPath) || ig.ignores(relPath + '/')) {
          continue;
        }


        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (supportedExtensions.has(ext)) {
            files.push(fullPath);
          }
        }
      }
    };

    walk(this.projectRoot);
    return files;
  }

  /**
   * Walks all project files, extracts imports, and persists File and FileEdge rows to DB.
   */
  public async build(): Promise<{ fileCount: number; edgeCount: number }> {
    const filePaths = this.discoverFiles();
    const filePathToDbId = new Map<string, string>();

    // 1. Upsert all File records
    for (const absPath of filePaths) {
      const relPath = path.relative(this.projectRoot, absPath);
      const hash = this.computeHash(absPath);

      const fileRecord = await this.prisma.file.upsert({
        where: {
          projectId_path: {
            projectId: this.projectId,
            path: relPath
          }
        },
        create: {
          projectId: this.projectId,
          path: relPath,
          contentHash: hash,
          lastScannedAt: new Date()
        },
        update: {
          contentHash: hash,
          lastScannedAt: new Date()
        }
      });

      filePathToDbId.set(absPath, fileRecord.id);
      filePathToDbId.set(relPath, fileRecord.id);
    }

    // 2. Extract edges and persist
    let totalEdges = 0;
    for (const absPath of filePaths) {
      const fromFileId = filePathToDbId.get(absPath)!;
      const importedPaths = extractImports(absPath, this.projectRoot);

      // Clear existing edges from this file
      await this.prisma.fileEdge.deleteMany({
        where: { fromFileId }
      });

      for (const targetAbsPath of importedPaths) {
        let toFileId = filePathToDbId.get(targetAbsPath);

        // If target file was not in initial pass
        if (!toFileId && fs.existsSync(targetAbsPath)) {
          const targetRelPath = path.relative(this.projectRoot, targetAbsPath);
          const hash = this.computeHash(targetAbsPath);
          const targetRecord = await this.prisma.file.upsert({
            where: {
              projectId_path: {
                projectId: this.projectId,
                path: targetRelPath
              }
            },
            create: {
              projectId: this.projectId,
              path: targetRelPath,
              contentHash: hash,
              lastScannedAt: new Date()
            },
            update: {
              contentHash: hash,
              lastScannedAt: new Date()
            }
          });
          toFileId = targetRecord.id;
          filePathToDbId.set(targetAbsPath, toFileId);
        }

        if (toFileId) {
          await this.prisma.fileEdge.upsert({
            where: {
              fromFileId_toFileId_edgeType: {
                fromFileId,
                toFileId,
                edgeType: EdgeType.imports
              }
            },
            create: {
              fromFileId,
              toFileId,
              edgeType: EdgeType.imports
            },
            update: {}
          });
          totalEdges++;
        }
      }
    }

    return { fileCount: filePaths.length, edgeCount: totalEdges };
  }

  /**
   * Re-parses just one file's edges for incremental updates.
   */
  public async rebuildFile(filePath: string): Promise<string[]> {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`File does not exist: ${absPath}`);
    }

    const relPath = path.relative(this.projectRoot, absPath);
    const hash = this.computeHash(absPath);

    const sourceFile = await this.prisma.file.upsert({
      where: {
        projectId_path: {
          projectId: this.projectId,
          path: relPath
        }
      },
      create: {
        projectId: this.projectId,
        path: relPath,
        contentHash: hash,
        lastScannedAt: new Date()
      },
      update: {
        contentHash: hash,
        lastScannedAt: new Date()
      }
    });

    // Remove old outgoing edges
    await this.prisma.fileEdge.deleteMany({
      where: { fromFileId: sourceFile.id }
    });

    const importedPaths = extractImports(absPath, this.projectRoot);
    const addedEdgeTargetIds: string[] = [];

    for (const targetAbsPath of importedPaths) {
      if (!fs.existsSync(targetAbsPath)) continue;
      const targetRelPath = path.relative(this.projectRoot, targetAbsPath);
      const targetHash = this.computeHash(targetAbsPath);

      const targetFile = await this.prisma.file.upsert({
        where: {
          projectId_path: {
            projectId: this.projectId,
            path: targetRelPath
          }
        },
        create: {
          projectId: this.projectId,
          path: targetRelPath,
          contentHash: targetHash,
          lastScannedAt: new Date()
        },
        update: {
          contentHash: targetHash
        }
      });

      await this.prisma.fileEdge.upsert({
        where: {
          fromFileId_toFileId_edgeType: {
            fromFileId: sourceFile.id,
            toFileId: targetFile.id,
            edgeType: EdgeType.imports
          }
        },
        create: {
          fromFileId: sourceFile.id,
          toFileId: targetFile.id,
          edgeType: EdgeType.imports
        },
        update: {}
      });

      addedEdgeTargetIds.push(targetFile.id);
    }

    return addedEdgeTargetIds;
  }

  /**
   * Traverses FileEdge in both directions (imports & imported_by) using BFS up to hop count.
   */
  public async getNeighbors(fileId: string, hops: number = 1): Promise<string[]> {
    return getNeighbors(fileId, hops, this.prisma);
  }
}

/**
 * Standalone getNeighbors traversal function doing BFS in both directions with cycle protection.
 */
export async function getNeighbors(
  fileId: string,
  hops: number = 1,
  prismaClient: PrismaClient = defaultPrisma
): Promise<string[]> {
  if (hops <= 0) {
    return [];
  }

  const visited = new Set<string>([fileId]);
  let currentLevel = new Set<string>([fileId]);

  for (let hop = 0; hop < hops; hop++) {
    if (currentLevel.size === 0) break;

    const currentIds = Array.from(currentLevel);
    const [outgoing, incoming] = await Promise.all([
      prismaClient.fileEdge.findMany({
        where: { fromFileId: { in: currentIds } },
        select: { toFileId: true }
      }),
      prismaClient.fileEdge.findMany({
        where: { toFileId: { in: currentIds } },
        select: { fromFileId: true }
      })
    ]);

    const nextLevel = new Set<string>();

    for (const edge of outgoing) {
      if (!visited.has(edge.toFileId)) {
        visited.add(edge.toFileId);
        nextLevel.add(edge.toFileId);
      }
    }

    for (const edge of incoming) {
      if (!visited.has(edge.fromFileId)) {
        visited.add(edge.fromFileId);
        nextLevel.add(edge.fromFileId);
      }
    }

    currentLevel = nextLevel;
  }

  visited.delete(fileId);
  return Array.from(visited);
}
