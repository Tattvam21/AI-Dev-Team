import { Task, Result, TeamName } from './task-schemas.js';
import { TeamAgent } from './team-agent.js';
import { SkillRegistry } from './skill-registry.js';
import { MemoryAgent } from '../memory-agent.js';

export interface ManagerOptions {
  skillRegistry?: SkillRegistry;
  llmModel?: string;
  llmClient?: any;
  projectRoot?: string;
}

/**
 * ManagerAgent
 *
 * Coordinates cross-team execution:
 * 1. Analyzes user goal and breaks it down into Tasks.
 * 2. Assigns tasks to the appropriate team (production, debugging, deployment).
 * 3. Enforces delegation loops and aggregates outputs.
 * 4. Logs results into team memory (.aidev/episodes.jsonl).
 */
export class ManagerAgent {
  private teams = new Map<TeamName, TeamAgent>();
  private memory: MemoryAgent;
  private projectRoot: string;

  constructor(options: ManagerOptions = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.memory = new MemoryAgent(this.projectRoot);

    const registry = options.skillRegistry ?? new SkillRegistry();

    // Initialize all 3 specialized teams
    this.teams.set('production', new TeamAgent('production', { skillRegistry: registry, llmModel: options.llmModel, llmClient: options.llmClient }));
    this.teams.set('debugging', new TeamAgent('debugging', { skillRegistry: registry, llmModel: options.llmModel, llmClient: options.llmClient }));
    this.teams.set('deployment', new TeamAgent('deployment', { skillRegistry: registry, llmModel: options.llmModel, llmClient: options.llmClient }));
  }

  /**
   * Dispatches a task to its assigned team.
   */
  public async dispatch(task: Task): Promise<Result> {
    const team = this.teams.get(task.assignedTeam);
    if (!team) {
      throw new Error(`Team '${task.assignedTeam}' does not exist.`);
    }

    const result = await team.execute(task);

    // Record episode in zero-postgres memory
    try {
      await this.memory.recordEpisode({
        ticketId: task.taskId,
        targetFile: task.context.targetFile || 'system',
        title: task.expectedOutput,
        verdict: result.status === 'done' ? 'pass' : 'fail',
        diffSummary: JSON.stringify(result.output).slice(0, 300),
        rationale: result.notes
      });
    } catch {
      // Memory recording non-blocking
    }

    return result;
  }

  /**
   * Helper to determine team for a task type.
   */
  public static resolveTeam(taskType: string): TeamName {
    const lower = taskType.toLowerCase();
    if (lower.includes('bug') || lower.includes('debug') || lower.includes('fix') || lower.includes('error')) {
      return 'debugging';
    }
    if (lower.includes('deploy') || lower.includes('release') || lower.includes('ci') || lower.includes('infra')) {
      return 'deployment';
    }
    return 'production';
  }
}
