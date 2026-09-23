import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MemoryAgent, EpisodeRecord } from './memory-agent.js';
import { extractCodeOutline } from './memory/code-ast-outline.js';

describe('MemoryAgent (Tiered Zero-Postgres Memory & Code AST Outline)', () => {
  let tempDir: string;
  let memoryAgent: MemoryAgent;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-mem-test-'));
    memoryAgent = new MemoryAgent(tempDir);
    MemoryAgent.clearL0Cache();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('initializes .aidev directory, rules.md, and episodes.jsonl', () => {
    memoryAgent.ensureInitialized();

    const memDir = path.join(tempDir, '.aidev');
    const rulesPath = path.join(memDir, 'rules.md');
    const episodesPath = path.join(memDir, 'episodes.jsonl');

    expect(fs.existsSync(memDir)).toBe(true);
    expect(fs.existsSync(rulesPath)).toBe(true);
    expect(fs.existsSync(episodesPath)).toBe(true);

    const rulesContent = fs.readFileSync(rulesPath, 'utf-8');
    expect(rulesContent).toContain('Repository Rules & Guidelines');
  });

  it('recalls rules and returns empty episodes when none exist', async () => {
    memoryAgent.ensureInitialized();
    const result = await memoryAgent.recall('src/auth.ts');

    expect(result.rules).toContain('Repository Rules & Guidelines');
    expect(result.episodes).toHaveLength(0);
    expect(result.formattedContext).toContain('Repository Rules & Guidelines');
    expect(result.formattedContext).not.toContain('Past Memory');
  });

  it('records and recalls episodes matching target file path with tiered levels', async () => {
    const ep1: EpisodeRecord = {
      ticketId: 't-1',
      targetFile: 'src/auth.ts',
      title: 'Fix token expiration bug',
      verdict: 'fail',
      reviewerNotes: 'Broke backward compatibility for legacy tokens'
    };

    const ep2: EpisodeRecord = {
      ticketId: 't-2',
      targetFile: 'src/utils/math.ts',
      title: 'Fix division by zero',
      verdict: 'pass',
      rationale: 'Added zero check guard'
    };

    const ep3: EpisodeRecord = {
      ticketId: 't-3',
      targetFile: 'src/auth.ts',
      title: 'Retry token expiration with fallback',
      verdict: 'pass',
      rationale: 'Added legacy token support'
    };

    const rec1 = await memoryAgent.recordEpisode(ep1);
    const rec2 = await memoryAgent.recordEpisode(ep2);
    const rec3 = await memoryAgent.recordEpisode(ep3);

    expect(rec1.recorded).toBe(true);
    expect(rec2.recorded).toBe(true);
    expect(rec3.recorded).toBe(true);

    const recallAuth = await memoryAgent.recall('src/auth.ts');

    expect(recallAuth.episodes).toHaveLength(2);
    expect(recallAuth.episodes[0].ticketId).toBe('t-1');
    expect(recallAuth.episodes[1].ticketId).toBe('t-3');
    expect(recallAuth.formattedContext).toContain('Previous rejection reason: "Broke backward compatibility for legacy tokens"');
    expect(recallAuth.formattedContext).toContain('Avoid repeating past rejected approaches');
    expect(recallAuth.tierUsed).toBe('L2');

    // Subsequent immediate recall should utilize L0 cache
    const l0Recall = await memoryAgent.recall('src/auth.ts');
    expect(l0Recall.tierUsed).toBe('L0');
  });

  it('filters out low-salience noise from episodic memory', async () => {
    const noisyEpisode: EpisodeRecord = {
      ticketId: 't-noise',
      targetFile: 'src/temp.ts',
      title: 'ok', // too short
      verdict: 'pass'
    };

    const result = await memoryAgent.recordEpisode(noisyEpisode);
    expect(result.recorded).toBe(false);
    expect(result.reason).toContain('Title too short');
  });

  it('extracts structural code outline without full source bodies', () => {
    const sampleCode = `
import fs from 'fs';
import { MemoryAgent } from './memory.js';

export interface UserSession {
  id: string;
  token: string;
}

export type AuthState = 'logged_in' | 'logged_out';

export class AuthService {
  public async login(user: string, pass: string): Promise<boolean> {
    // long implementation here
    return true;
  }

  private validateToken(token: string): boolean {
    return token.length > 0;
  }
}

export async function hashPassword(raw: string): Promise<string> {
  return raw + '_hashed';
}
`;

    const outline = extractCodeOutline('src/auth.ts', sampleCode);

    expect(outline.filePath).toBe('src/auth.ts');
    expect(outline.typesAndInterfaces).toContain('interface UserSession');
    expect(outline.typesAndInterfaces).toContain('type AuthState');
    expect(outline.classes[0].name).toBe('AuthService');
    expect(outline.classes[0].methods).toContain('login(user: string, pass: string)');
    expect(outline.functions).toContain('hashPassword(raw: string)');
  });

  it('allows adding new procedural rules', async () => {
    await memoryAgent.addRule('Always use crypto.randomUUID instead of uuid package', 'Security');
    const recall = await memoryAgent.recall('any-file.ts');

    expect(recall.rules).toContain('[Security] Always use crypto.randomUUID instead of uuid package');
    expect(recall.formattedContext).toContain('[Security] Always use crypto.randomUUID');
  });
});
