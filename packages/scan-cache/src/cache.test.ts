import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { prisma } from '@ai-dev-team/db';
import { GraphBuilder } from '@ai-dev-team/dependency-graph';
import {
  computeContentHash,
  getImpactedSet,
  syncProjectScanCache,
  findChangedFiles
} from './cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('ScanCache and Impacted-Set calculation', () => {
  let tempProjectDir: string;
  let testProjectId: string;

  beforeAll(async () => {
    // 1. Create a temporary project directory
    tempProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-cache-test-'));

    // Copy fixture files into the temp directory
    const fixtureDir = path.resolve(
      __dirname,
      '../../dependency-graph/src/__fixtures__/sample-project'
    );
    fs.cpSync(fixtureDir, tempProjectDir, { recursive: true });

    // 2. Create DB project record
    const project = await prisma.project.create({
      data: {
        name: `scan-cache-test-${Date.now()}`,
        localPath: tempProjectDir
      }
    });
    testProjectId = project.id;

    // 3. Build graph
    const builder = new GraphBuilder(testProjectId, tempProjectDir, { prisma });
    await builder.build();
  });

  afterAll(async () => {
    // Cleanup DB records and temp files
    if (testProjectId) {
      await prisma.project.delete({
        where: { id: testProjectId }
      });
    }
    await prisma.$disconnect();

    if (tempProjectDir && fs.existsSync(tempProjectDir)) {
      fs.rmSync(tempProjectDir, { recursive: true, force: true });
    }
  });

  it('should compute SHA-256 content hashes correctly', () => {
    const entryFile = path.join(tempProjectDir, 'src/entry.ts');
    const hash1 = computeContentHash(entryFile);
    const hash2 = computeContentHash(entryFile);

    expect(hash1).toBeDefined();
    expect(hash1).toHaveLength(64);
    expect(hash1).toBe(hash2);
  });

  it('should return all un-cached files as changed on first run, then none after sync', async () => {
    // Initial run: no files cached in ScanCache
    const initialChanged = await findChangedFiles(testProjectId, prisma);
    expect(initialChanged.length).toBeGreaterThanOrEqual(4);

    const initialImpacted = await getImpactedSet(testProjectId, { prisma });
    expect(initialImpacted.length).toBeGreaterThanOrEqual(4);

    // Sync all files
    const allPaths = initialChanged.map((f) => f.path);
    await syncProjectScanCache(testProjectId, allPaths, prisma);

    // Now nothing should be changed
    const postSyncChanged = await findChangedFiles(testProjectId, prisma);
    expect(postSyncChanged).toHaveLength(0);

    const postSyncImpacted = await getImpactedSet(testProjectId, { prisma });
    expect(postSyncImpacted).toHaveLength(0);
  });

  it('should identify a single modified file and expand only to its dependents', async () => {
    const relativeTarget = path.join(tempProjectDir, 'src/relative-target.ts');

    // Modify relative-target.ts
    const originalContent = fs.readFileSync(relativeTarget, 'utf-8');
    fs.writeFileSync(
      relativeTarget,
      originalContent + '\n// modified comment for change detection'
    );

    // Rebuild edges for the changed file in dependency graph
    const builder = new GraphBuilder(testProjectId, tempProjectDir, { prisma });
    await builder.rebuildFile(relativeTarget);

    // Find changed files: should be only src/relative-target.ts
    const changed = await findChangedFiles(testProjectId, prisma);
    expect(changed).toHaveLength(1);
    expect(changed[0].path).toBe('src/relative-target.ts');

    // getImpactedSet should include relative-target.ts AND entry.ts (which imports it)
    const impacted = await getImpactedSet(testProjectId, { prisma, hops: 1 });

    expect(impacted).toContain('src/relative-target.ts');
    expect(impacted).toContain('src/entry.ts');

    // Should NOT contain unaffected siblings
    expect(impacted).not.toContain('src/aliased/alias-target.ts');
    expect(impacted).not.toContain('src/dynamic-target.ts');
    expect(impacted).toHaveLength(2);
  });
});
