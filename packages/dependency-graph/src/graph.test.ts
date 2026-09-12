import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { prisma } from '@ai-dev-team/db';
import { GraphBuilder, getNeighbors } from './graph.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('GraphBuilder and getNeighbors', () => {
  const fixtureProjectRoot = path.join(__dirname, '__fixtures__/sample-project');
  let testProjectId: string;

  beforeAll(async () => {
    // Create a dedicated project for testing
    const project = await prisma.project.create({
      data: {
        name: `test-graph-${Date.now()}`,
        localPath: fixtureProjectRoot
      }
    });
    testProjectId = project.id;
  });

  afterAll(async () => {
    // Cleanup project and cascade all files/edges
    if (testProjectId) {
      await prisma.project.delete({
        where: { id: testProjectId }
      });
    }
    await prisma.$disconnect();
  });

  it('should discover files, extract imports, and persist File and FileEdge rows to the database', async () => {
    const builder = new GraphBuilder(testProjectId, fixtureProjectRoot, { prisma });
    const { fileCount, edgeCount } = await builder.build();

    expect(fileCount).toBeGreaterThanOrEqual(4);
    expect(edgeCount).toBe(3);

    // Verify File rows in database
    const files = await prisma.file.findMany({
      where: { projectId: testProjectId }
    });
    const paths = files.map((f) => f.path);
    expect(paths).toContain('src/entry.ts');
    expect(paths).toContain('src/relative-target.ts');
    expect(paths).toContain('src/aliased/alias-target.ts');
    expect(paths).toContain('src/dynamic-target.ts');

    const entryFile = files.find((f) => f.path === 'src/entry.ts')!;

    // Verify FileEdge rows from entry.ts
    const edges = await prisma.fileEdge.findMany({
      where: { fromFileId: entryFile.id }
    });
    expect(edges).toHaveLength(3);
  });

  it('should traverse in both directions with cycle protection via getNeighbors', async () => {
    const builder = new GraphBuilder(testProjectId, fixtureProjectRoot, { prisma });
    await builder.build();

    const files = await prisma.file.findMany({
      where: { projectId: testProjectId }
    });

    const entryFile = files.find((f) => f.path === 'src/entry.ts')!;
    const relFile = files.find((f) => f.path === 'src/relative-target.ts')!;
    const aliasFile = files.find((f) => f.path === 'src/aliased/alias-target.ts')!;
    const dynFile = files.find((f) => f.path === 'src/dynamic-target.ts')!;

    // Outgoing direction: entry.ts -> [relFile, aliasFile, dynFile]
    const neighbors1Hop = await builder.getNeighbors(entryFile.id, 1);
    expect(neighbors1Hop).toHaveLength(3);
    expect(neighbors1Hop).toContain(relFile.id);
    expect(neighbors1Hop).toContain(aliasFile.id);
    expect(neighbors1Hop).toContain(dynFile.id);

    // Incoming direction: relFile -> imported_by -> entryFile
    const relNeighbors = await builder.getNeighbors(relFile.id, 1);
    expect(relNeighbors).toContain(entryFile.id);

    // 2-Hop from relFile should include sibling files through entryFile
    const relNeighbors2Hops = await builder.getNeighbors(relFile.id, 2);
    expect(relNeighbors2Hops).toContain(entryFile.id);
    expect(relNeighbors2Hops).toContain(aliasFile.id);
    expect(relNeighbors2Hops).toContain(dynFile.id);
    // Cycle protection: original node relFile is excluded
    expect(relNeighbors2Hops).not.toContain(relFile.id);
  });

  it('should rebuild edges for a single file incrementally', async () => {
    const builder = new GraphBuilder(testProjectId, fixtureProjectRoot, { prisma });
    const entryFilePath = path.join(fixtureProjectRoot, 'src/entry.ts');

    const addedTargetIds = await builder.rebuildFile(entryFilePath);
    expect(addedTargetIds).toHaveLength(3);

    const files = await prisma.file.findMany({
      where: { projectId: testProjectId }
    });
    const entryFile = files.find((f) => f.path === 'src/entry.ts')!;

    const edges = await prisma.fileEdge.findMany({
      where: { fromFileId: entryFile.id }
    });
    expect(edges).toHaveLength(3);
  });
});
