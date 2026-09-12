import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { runStaticAnalysis } from './static-analysis.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Static Analysis Wrapper (ESLint)', () => {
  const fixturesDir = path.join(__dirname, '__fixtures__');
  const lintProjectDir = path.join(fixturesDir, 'lint-project');
  const noConfigProjectDir = path.join(fixturesDir, 'no-config-project');

  it('should detect known lint violation (unused variable) and return normalized finding', async () => {
    const dirtyFile = path.join(lintProjectDir, 'dirty.js');
    const findings = await runStaticAnalysis([dirtyFile], { cwd: lintProjectDir });

    expect(findings.length).toBeGreaterThanOrEqual(1);

    const unusedFinding = findings.find((f) => f.ruleId === 'no-unused-vars');
    expect(unusedFinding).toBeDefined();
    expect(unusedFinding!.file).toBe(dirtyFile);
    expect(unusedFinding!.line).toBe(1);
    expect(unusedFinding!.severity).toBe('error');
    expect(unusedFinding!.message).toContain('unusedVariable');
  });

  it('should return empty findings for a clean file', async () => {
    const cleanFile = path.join(lintProjectDir, 'clean.js');
    const findings = await runStaticAnalysis([cleanFile], { cwd: lintProjectDir });

    expect(findings).toHaveLength(0);
  });

  it('should gracefully handle missing ESLint config without crashing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const file = path.join(noConfigProjectDir, 'dirty.js');
    const findings = await runStaticAnalysis([file], { cwd: noConfigProjectDir });

    expect(findings).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    const warningMsg = warnSpy.mock.calls[0][0];
    expect(warningMsg).toContain('No ESLint configuration found');

    warnSpy.mockRestore();
  });

  it('should return empty list when given empty file array', async () => {
    const findings = await runStaticAnalysis([]);
    expect(findings).toEqual([]);
  });
});
