import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DiagramGenerator, DiagramSpecification } from './diagram-generator.js';

describe('DiagramGenerator (SVG & Mermaid Architecture Diagrams)', () => {
  let tempDir: string;
  let generator: DiagramGenerator;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-diagram-test-'));
    generator = new DiagramGenerator(tempDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('generates mermaid syntax from spec', () => {
    const spec: DiagramSpecification = {
      title: 'Test Architecture',
      nodes: [
        { id: 'mgr', label: 'Manager Agent', type: 'agent' },
        { id: 'prod', label: 'Production Team', type: 'team' },
        { id: 'mem', label: 'Flat-file Memory', type: 'database' }
      ],
      edges: [
        { from: 'mgr', to: 'prod', label: 'delegates' },
        { from: 'prod', to: 'mem', label: 'records' }
      ]
    };

    const mermaid = generator.generateMermaid(spec);

    expect(mermaid).toContain('flowchart TD');
    expect(mermaid).toContain('mgr[/"Manager Agent"/]');
    expect(mermaid).toContain('prod{{Production Team}}');
    expect(mermaid).toContain('mem[(Flat-file Memory)]');
    expect(mermaid).toContain('mgr -->|delegates| prod');
  });

  it('saves both .svg and .mmd diagram files to disk', async () => {
    const spec: DiagramSpecification = {
      title: 'Dev Team Overview',
      nodes: [
        { id: 'a1', label: 'Service A', type: 'service' },
        { id: 'a2', label: 'Service B', type: 'service' }
      ],
      edges: [
        { from: 'a1', to: 'a2', label: 'calls' }
      ]
    };

    const files = await generator.saveDiagram('system_arch', spec);

    expect(fs.existsSync(files.mermaidPath)).toBe(true);
    expect(fs.existsSync(files.svgPath)).toBe(true);

    const svgContent = fs.readFileSync(files.svgPath, 'utf-8');
    expect(svgContent).toContain('<svg');
    expect(svgContent).toContain('Dev Team Overview');
  });
});
