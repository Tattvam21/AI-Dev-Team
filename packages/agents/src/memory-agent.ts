import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { extractCodeOutline, formatOutlineAsMarkdown, type CodeOutline } from './memory/code-ast-outline.ts';

export interface EpisodeRecord {
  ticketId: string;
  targetFile: string;
  title: string;
  verdict: 'pass' | 'fail' | 'disputed';
  diffSummary?: string;
  rationale?: string;
  reviewerNotes?: string;
  timestamp?: string;
  salienceScore?: number; // 0 to 1 score indicating importance
}

export interface RecallOptions {
  maxEpisodes?: number;
  includeRules?: boolean;
  includeOutline?: boolean;
  minTier?: 'L0' | 'L1' | 'L2';
}

export interface MemoryRecallResult {
  rules: string;
  episodes: EpisodeRecord[];
  codeOutline?: CodeOutline;
  formattedContext: string;
  tierUsed: 'L0' | 'L1' | 'L2';
}

/**
 * MemoryAgent
 * 
 * Provides lightweight, zero-external-database persistent memory for AI agents.
 * Features a 3-tier hierarchy:
 * - L0: In-memory session cache (instantaneous)
 * - L1: Procedural rules (.aidev/rules.md)
 * - L2: Lazy-loaded episodic history (.aidev/episodes.jsonl)
 * 
 * Includes salience filtering to prevent duplicate or noisy episode logging,
 * and structural code outlines for token-efficient file context.
 */
export class MemoryAgent {
  private memDir: string;
  private rulesFile: string;
  private episodesFile: string;
  private projectRoot: string;
  
  // L0: In-memory session cache
  private static l0Cache = new Map<string, { timestamp: number; data: MemoryRecallResult }>();
  private static l0CacheTtlMs = 60000; // 1 minute TTL

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
    this.memDir = path.join(this.projectRoot, '.aidev');
    this.rulesFile = path.join(this.memDir, 'rules.md');
    this.episodesFile = path.join(this.memDir, 'episodes.jsonl');
  }

  /**
   * Ensures the .aidev directory and base files exist.
   */
  public ensureInitialized(): void {
    if (!fs.existsSync(this.memDir)) {
      fs.mkdirSync(this.memDir, { recursive: true });
    }
    if (!fs.existsSync(this.rulesFile)) {
      const defaultRules = `# Repository Rules & Guidelines\n\n- Adhere to the established code architecture and styling conventions.\n- Do not introduce unnecessary dependencies when standard library or existing helpers suffice.\n- Ensure changes are backward-compatible and accompanied by verification.\n`;
      fs.writeFileSync(this.rulesFile, defaultRules, 'utf-8');
    }
    if (!fs.existsSync(this.episodesFile)) {
      fs.writeFileSync(this.episodesFile, '', 'utf-8');
    }
  }

  /**
   * Tiered recall: checks L0 cache -> L1 rules -> L2 historical episodes.
   */
  public async recall(targetFilePath: string, options: RecallOptions = {}): Promise<MemoryRecallResult> {
    const cacheKey = `${this.projectRoot}:${targetFilePath}:${JSON.stringify(options)}`;
    
    // 1. Check L0 In-Memory Cache
    const cached = MemoryAgent.l0Cache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < MemoryAgent.l0CacheTtlMs) {
      return { ...cached.data, tierUsed: 'L0' };
    }

    const maxEpisodes = options.maxEpisodes ?? 3;
    const includeRules = options.includeRules ?? true;
    const includeOutline = options.includeOutline ?? false;

    // 2. L1: Procedural Rules
    let rules = '';
    if (includeRules && fs.existsSync(this.rulesFile)) {
      try {
        rules = await fs.promises.readFile(this.rulesFile, 'utf-8');
      } catch {
        rules = '';
      }
    }

    // Optional: Extract Code Outline for token-efficient structural context
    let codeOutline: CodeOutline | undefined;
    if (includeOutline && targetFilePath) {
      const fullPath = path.isAbsolute(targetFilePath) ? targetFilePath : path.join(this.projectRoot, targetFilePath);
      if (fs.existsSync(fullPath)) {
        try {
          const source = await fs.promises.readFile(fullPath, 'utf-8');
          codeOutline = extractCodeOutline(targetFilePath, source);
        } catch {
          // Ignore outline extraction failure
        }
      }
    }

    // 3. L2: Episodic Memory Stream
    const matchedEpisodes: EpisodeRecord[] = [];
    const normalizedTarget = path.normalize(targetFilePath || '').replace(/\\/g, '/');

    if (fs.existsSync(this.episodesFile) && targetFilePath) {
      try {
        const fileStream = fs.createReadStream(this.episodesFile, { encoding: 'utf-8' });
        const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

        for await (const line of rl) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const ep: EpisodeRecord = JSON.parse(trimmed);
            const epTarget = path.normalize(ep.targetFile || '').replace(/\\/g, '/');
            if (epTarget === normalizedTarget || epTarget.endsWith(normalizedTarget) || normalizedTarget.endsWith(epTarget)) {
              matchedEpisodes.push(ep);
            }
          } catch {
            // Ignore malformed JSON lines
          }
        }
      } catch {
        // Stream read failure fallback
      }
    }

    const recentEpisodes = matchedEpisodes.slice(-maxEpisodes);
    const formattedContext = this.formatContext(rules, recentEpisodes, targetFilePath, codeOutline);

    const result: MemoryRecallResult = {
      rules,
      episodes: recentEpisodes,
      codeOutline,
      formattedContext,
      tierUsed: recentEpisodes.length > 0 ? 'L2' : (rules ? 'L1' : 'L0')
    };

    // Store in L0 Cache
    MemoryAgent.l0Cache.set(cacheKey, { timestamp: Date.now(), data: result });

    return result;
  }

  /**
   * Salience filter: checks if an episode has enough actionable information
   * and avoids duplicate logging of trivial/empty episodes.
   */
  public evaluateSalience(episode: EpisodeRecord): { shouldRecord: boolean; score: number; reason: string } {
    if (!episode.title || episode.title.trim().length < 4) {
      return { shouldRecord: false, score: 0, reason: 'Title too short or missing' };
    }

    let score = 0.5;

    // Failures or rejections carry high learning value
    if (episode.verdict === 'fail' || episode.verdict === 'disputed') {
      score += 0.3;
    }

    // Reviewer notes or rationales boost salience
    if (episode.reviewerNotes && episode.reviewerNotes.length > 10) {
      score += 0.2;
    }
    if (episode.rationale && episode.rationale.length > 15) {
      score += 0.1;
    }
    if (episode.diffSummary && episode.diffSummary.length > 10) {
      score += 0.1;
    }

    score = Math.min(1.0, score);
    const shouldRecord = score >= 0.5;

    return {
      shouldRecord,
      score,
      reason: shouldRecord ? 'Sufficient actionable signal' : 'Low informational value'
    };
  }

  /**
   * Appends an episode to the episodic log (.aidev/episodes.jsonl) with salience filtering.
   */
  public async recordEpisode(episode: EpisodeRecord, force: boolean = false): Promise<{ recorded: boolean; reason: string; salienceScore: number }> {
    this.ensureInitialized();

    const salience = this.evaluateSalience(episode);
    if (!salience.shouldRecord && !force) {
      return { recorded: false, reason: salience.reason, salienceScore: salience.score };
    }

    const record: EpisodeRecord = {
      ...episode,
      salienceScore: salience.score,
      timestamp: episode.timestamp ?? new Date().toISOString()
    };

    const line = JSON.stringify(record) + '\n';
    await fs.promises.appendFile(this.episodesFile, line, 'utf-8');

    // Invalidate L0 cache for this project
    MemoryAgent.clearL0Cache();

    return { recorded: true, reason: 'Recorded successfully', salienceScore: salience.score };
  }

  /**
   * Appends a new rule to .aidev/rules.md.
   */
  public async addRule(rule: string, category: string = 'General'): Promise<void> {
    this.ensureInitialized();
    const formattedRule = `\n- [${category}] ${rule.trim()}`;
    await fs.promises.appendFile(this.rulesFile, formattedRule, 'utf-8');
    MemoryAgent.clearL0Cache();
  }

  /**
   * Clears L0 session cache.
   */
  public static clearL0Cache(): void {
    MemoryAgent.l0Cache.clear();
  }

  /**
   * Formats retrieved rules, episodes, and outlines into a prompt-ready markdown section.
   */
  private formatContext(rules: string, episodes: EpisodeRecord[], targetFile: string, outline?: CodeOutline): string {
    const sections: string[] = [];

    if (rules.trim()) {
      sections.push(`### Repository Rules & Guidelines:\n${rules.trim()}`);
    }

    if (outline) {
      sections.push(`### Structural Code Outline:\n${formatOutlineAsMarkdown(outline)}`);
    }

    if (episodes.length > 0) {
      const epLines = episodes.map((ep) => {
        const statusTag = ep.verdict.toUpperCase();
        let details = ep.title;
        if (ep.verdict === 'fail' && ep.reviewerNotes) {
          details += ` — Previous rejection reason: "${ep.reviewerNotes}"`;
        } else if (ep.rationale) {
          details += ` — Rationale: ${ep.rationale}`;
        }
        return `- [${statusTag}] ${details}`;
      });

      sections.push(`### Past Memory for '${path.basename(targetFile)}':\n${epLines.join('\n')}\n*Note: Avoid repeating past rejected approaches.*`);
    }

    return sections.join('\n\n');
  }
}
