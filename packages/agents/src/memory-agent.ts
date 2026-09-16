import fs from 'fs';
import path from 'path';
import readline from 'readline';

export interface EpisodeRecord {
  ticketId: string;
  targetFile: string;
  title: string;
  verdict: 'pass' | 'fail' | 'disputed';
  diffSummary?: string;
  rationale?: string;
  reviewerNotes?: string;
  timestamp?: string;
}

export interface RecallOptions {
  maxEpisodes?: number;
  includeRules?: boolean;
}

export interface MemoryRecallResult {
  rules: string;
  episodes: EpisodeRecord[];
  formattedContext: string;
}

/**
 * MemoryAgent
 * 
 * Provides lightweight, zero-external-database persistent memory for AI agents.
 * Backed by a Git-friendly `.aidev/` directory in the target repository root:
 * - `rules.md`: Procedural memory (coding guidelines, architectural constraints).
 * - `episodes.jsonl`: Episodic memory (append-only log of past tickets, patches, and reviewer verdicts).
 */
export class MemoryAgent {
  private memDir: string;
  private rulesFile: string;
  private episodesFile: string;

  constructor(projectRoot: string) {
    this.memDir = path.join(path.resolve(projectRoot), '.aidev');
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
   * Recalls rules and past relevant episodes for a target file.
   */
  public async recall(targetFilePath: string, options: RecallOptions = {}): Promise<MemoryRecallResult> {
    const maxEpisodes = options.maxEpisodes ?? 3;
    const includeRules = options.includeRules ?? true;

    let rules = '';
    if (includeRules && fs.existsSync(this.rulesFile)) {
      try {
        rules = await fs.promises.readFile(this.rulesFile, 'utf-8');
      } catch {
        rules = '';
      }
    }

    const matchedEpisodes: EpisodeRecord[] = [];
    const normalizedTarget = path.normalize(targetFilePath).replace(/\\/g, '/');

    if (fs.existsSync(this.episodesFile)) {
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
    const formattedContext = this.formatContext(rules, recentEpisodes, targetFilePath);

    return {
      rules,
      episodes: recentEpisodes,
      formattedContext
    };
  }

  /**
   * Appends an episode to the episodic log (.aidev/episodes.jsonl).
   */
  public async recordEpisode(episode: EpisodeRecord): Promise<void> {
    this.ensureInitialized();
    const record: EpisodeRecord = {
      ...episode,
      timestamp: episode.timestamp ?? new Date().toISOString()
    };
    const line = JSON.stringify(record) + '\n';
    await fs.promises.appendFile(this.episodesFile, line, 'utf-8');
  }

  /**
   * Appends a new rule to .aidev/rules.md.
   */
  public async addRule(rule: string, category: string = 'General'): Promise<void> {
    this.ensureInitialized();
    const formattedRule = `\n- [${category}] ${rule.trim()}`;
    await fs.promises.appendFile(this.rulesFile, formattedRule, 'utf-8');
  }

  /**
   * Formats retrieved rules and episodes into a prompt-ready markdown section.
   */
  private formatContext(rules: string, episodes: EpisodeRecord[], targetFile: string): string {
    const sections: string[] = [];

    if (rules.trim()) {
      sections.push(`### Repository Rules & Guidelines:\n${rules.trim()}`);
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
