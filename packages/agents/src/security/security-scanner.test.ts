import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runSecurityScan } from './security-scanner.js';

describe('Security & Secrets Scanner', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-sec-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('detects exposed AWS access keys and API keys', async () => {
    const vulnCode = `
      export const config = {
        awsKey: "AKIAIOSFODNN7EXAMPLE",
        apiKey: "api_key = 'abcdef1234567890abcdef1234567890'"
      };
    `;
    const filePath = path.join(tempDir, 'vuln.ts');
    fs.writeFileSync(filePath, vulnCode, 'utf-8');

    const report = await runSecurityScan(tempDir, ['vuln.ts']);

    expect(report.passed).toBe(false);
    expect(report.criticalCount).toBeGreaterThanOrEqual(1);
    expect(report.findings.some(f => f.matchedPattern.includes('AWS'))).toBe(true);
  });

  it('detects unsafe eval patterns', async () => {
    const unsafeCode = `
      export function executeDynamic(input: string) {
        return eval(input);
      }
    `;
    const filePath = path.join(tempDir, 'unsafe.ts');
    fs.writeFileSync(filePath, unsafeCode, 'utf-8');

    const report = await runSecurityScan(tempDir, ['unsafe.ts']);

    expect(report.passed).toBe(false);
    expect(report.highCount).toBeGreaterThanOrEqual(1);
    expect(report.findings.some(f => f.matchedPattern.includes('eval'))).toBe(true);
  });

  it('passes on clean code', async () => {
    const cleanCode = `
      export function add(a: number, b: number): number {
        return a + b;
      }
    `;
    const filePath = path.join(tempDir, 'clean.ts');
    fs.writeFileSync(filePath, cleanCode, 'utf-8');

    const report = await runSecurityScan(tempDir, ['clean.ts']);

    expect(report.passed).toBe(true);
    expect(report.totalFindings).toBe(0);
  });
});
