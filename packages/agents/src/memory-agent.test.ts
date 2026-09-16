import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MemoryAgent, EpisodeRecord } from './memory-agent.js';

describe('MemoryAgent (Zero-Postgres File Memory)', () => {
  let tempDir: string;
  let memoryAgent: MemoryAgent;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-mem-test-'));
    memoryAgent = new MemoryAgent(tempDir);
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

  it('records and recalls episodes matching target file path', async () => {
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

    await memoryAgent.recordEpisode(ep1);
    await memoryAgent.recordEpisode(ep2);
    await memoryAgent.recordEpisode(ep3);

    const recallAuth = await memoryAgent.recall('src/auth.ts');

    expect(recallAuth.episodes).toHaveLength(2);
    expect(recallAuth.episodes[0].ticketId).toBe('t-1');
    expect(recallAuth.episodes[1].ticketId).toBe('t-3');
    expect(recallAuth.formattedContext).toContain('Previous rejection reason: "Broke backward compatibility for legacy tokens"');
    expect(recallAuth.formattedContext).toContain('Avoid repeating past rejected approaches');

    // Querying other file returns only ep2
    const recallMath = await memoryAgent.recall('src/utils/math.ts');
    expect(recallMath.episodes).toHaveLength(1);
    expect(recallMath.episodes[0].ticketId).toBe('t-2');
  });

  it('allows adding new procedural rules', async () => {
    await memoryAgent.addRule('Always use crypto.randomUUID instead of uuid package', 'Security');
    const recall = await memoryAgent.recall('any-file.ts');

    expect(recall.rules).toContain('[Security] Always use crypto.randomUUID instead of uuid package');
    expect(recall.formattedContext).toContain('[Security] Always use crypto.randomUUID');
  });
});
