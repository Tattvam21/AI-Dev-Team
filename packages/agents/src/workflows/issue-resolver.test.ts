import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { IssueResolverPipeline } from './issue-resolver-pipeline.js';
import { TelemetryVisualizer } from './telemetry-visualizer.js';

describe('Autonomous Issue Resolver Pipeline & Telemetry', () => {
  let tempDir: string;
  let pipeline: IssueResolverPipeline;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-pipeline-test-'));
    pipeline = new IssueResolverPipeline({ projectRoot: tempDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('runs end-to-end issue intake, triage, execution, verification, and generates telemetry snapshot', async () => {
    // Create a target file in tempDir
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const targetFile = path.join(srcDir, 'calc.ts');
    fs.writeFileSync(targetFile, 'export function multiply(a: number, b: number) { return a * b; }', 'utf-8');

    const result = await pipeline.resolveIssue({
      issueId: '101',
      title: 'Fix edge case in multiplication with zero',
      body: 'When multiplying by zero, ensure return is valid number.',
      targetFile: 'src/calc.ts',
      labels: ['bug', 'calculation']
    });

    expect(result.issueId).toBe('101');
    expect(result.stages.triage.assignedTeam).toBe('debugging');
    expect(result.stages.triage.outlineExtracted).toBe(true);
    expect(result.stages.securityCheck.passed).toBe(true);
    expect(result.telemetry.nodes.length).toBeGreaterThanOrEqual(3);
    expect(result.telemetry.edges.length).toBeGreaterThanOrEqual(2);
  });

  it('visualizer formats clean ASCII workflow graph', () => {
    const viz = new TelemetryVisualizer('run-1', 'Implement new feature');
    viz.recordNode({ id: 'n1', name: 'Intake', type: 'manager', status: 'completed', timestamp: new Date().toISOString() });
    viz.recordNode({ id: 'n2', name: 'Production Loop', type: 'team', status: 'completed', timestamp: new Date().toISOString(), durationMs: 150 });
    viz.recordEdge('n1', 'n2', 'delegated');

    const ascii = viz.renderAsciiGraph();
    expect(ascii).toContain('AI Dev Team Execution Telemetry');
    expect(ascii).toContain('[✔] [MANAGER] Intake');
    expect(ascii).toContain('[✔] [TEAM] Production Loop (150ms)');
    expect(ascii).toContain('n1 ──(delegated)──> n2');
  });
});
