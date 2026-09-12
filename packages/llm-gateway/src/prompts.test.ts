import { describe, it, expect } from 'vitest';
import { loadPrompt, loadPromptWithVersion, substituteVariables } from './prompts.js';

describe('Prompt template loader', () => {
  it('should substitute simple variables correctly', () => {
    const template = 'Hello {{name}}, welcome to {{project}}!';
    const substituted = substituteVariables(template, { name: 'Alice', project: 'AI Dev Team' });
    expect(substituted).toBe('Hello Alice, welcome to AI Dev Team!');
  });

  it("should load the scanner prompt and substitute variables correctly given test input", () => {
    const prompt = loadPrompt('scanner', 'latest', {
      filePath: 'src/utils/math.ts',
      fileContent: 'export function add(a, b) { return a + b; }',
      dependencies: 'none',
      callers: 'src/index.ts'
    });

    expect(prompt).toContain('Target File:\n- Path: src/utils/math.ts');
    expect(prompt).toContain('export function add(a, b) { return a + b; }');
    expect(prompt).toContain('1-Hop Callers (Files that import this file):\nsrc/index.ts');
    expect(prompt).toContain('root_cause_file if the true defect originates outside src/utils/math.ts');
  });

  it('should load prompts for all 5 roles (scanner, triage, fixer, reviewer, test-writer)', () => {
    const roles = ['scanner', 'triage', 'fixer', 'reviewer', 'test-writer'] as const;

    for (const role of roles) {
      const { content, version, role: loadedRole } = loadPromptWithVersion(role);
      expect(loadedRole).toBe(role);
      expect(version).toBe('v1');
      expect(content).toBeDefined();
      expect(content.length).toBeGreaterThan(50);
    }
  });

  it('should support explicit version loading', () => {
    const prompt = loadPrompt('triage', 'v1', { tickets: '- Ticket 1: Null check bug' });
    expect(prompt).toContain('- Ticket 1: Null check bug');
    expect(prompt).toContain('Triage Agent');
  });

  it('should throw descriptive error if role directory does not exist', () => {
    expect(() => loadPrompt('non-existent-role')).toThrow(/Prompt directory not found/);
  });
});
