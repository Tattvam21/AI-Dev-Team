import { type Task, type Result, type TeamName, type RiskAssessment, type RiskLevel } from './task-schemas.ts';
import { TeamAgent } from './team-agent.ts';
import { SkillRegistry } from './skill-registry.ts';
import { MemoryAgent } from '../memory-agent.ts';

export interface ManagerOptions {
  skillRegistry?: SkillRegistry;
  llmModel?: string;
  llmClient?: any;
  projectRoot?: string;
  enforceRiskGate?: boolean;
}

/**
 * ManagerAgent
 *
 * Coordinates cross-team execution via a Two-Loop Supervisor pattern:
 * - Loop 1: Planning & Risk Assessment Loop (evaluates task intent, risk profile, and safety constraints)
 * - Loop 2: Execution & Verification Loop (delegates to TeamAgent, validates outcomes, records filtered memory)
 */
export class ManagerAgent {
  private teams = new Map<TeamName, TeamAgent>();
  private memory: MemoryAgent;
  private projectRoot: string;
  private enforceRiskGate: boolean;
  private registry: SkillRegistry;

  constructor(options: ManagerOptions = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.memory = new MemoryAgent(this.projectRoot);
    this.enforceRiskGate = options.enforceRiskGate ?? true;
    this.registry = options.skillRegistry ?? new SkillRegistry();

    // Initialize specialized teams
    this.teams.set('production', new TeamAgent('production', { skillRegistry: this.registry, llmModel: options.llmModel, llmClient: options.llmClient }));
    this.teams.set('debugging', new TeamAgent('debugging', { skillRegistry: this.registry, llmModel: options.llmModel, llmClient: options.llmClient }));
    this.teams.set('deployment', new TeamAgent('deployment', { skillRegistry: this.registry, llmModel: options.llmModel, llmClient: options.llmClient }));
  }

  /**
   * Assesses risk of a given task before dispatch (Loop 1: Risk Assessment).
   */
  public evaluateTaskRisk(task: Task): RiskAssessment {
    const reasons: string[] = [];
    let score = 2; // base score

    const taskStr = `${task.taskType} ${task.expectedOutput} ${JSON.stringify(task.context)}`.toLowerCase();

    if (task.assignedTeam === 'deployment') {
      score += 5;
      reasons.push('Deployment actions affect external environments');
    }

    if (taskStr.includes('delete') || taskStr.includes('rm ') || taskStr.includes('drop')) {
      score += 4;
      reasons.push('Contains destructive deletion keywords');
    }

    if (taskStr.includes('deploy') || taskStr.includes('release') || taskStr.includes('prod')) {
      score += 3;
      reasons.push('Targeting deployment or production environment');
    }

    if (taskStr.includes('security') || taskStr.includes('vulnerability') || taskStr.includes('secret')) {
      score += 2;
      reasons.push('Modifies or addresses security-critical code');
    }

    score = Math.min(10, Math.max(0, score));
    const level: RiskLevel = score >= 8 ? 'high' : (score >= 4 ? 'medium' : 'low');
    const requiresApproval = this.enforceRiskGate && level === 'high';

    return {
      level,
      score,
      reasons,
      requiresApproval
    };
  }

  /**
   * Dispatches a task to its assigned team through the two-loop supervisor.
   */
  public async dispatch(task: Task): Promise<Result> {
    const team = this.teams.get(task.assignedTeam);
    if (!team) {
      throw new Error(`Team '${task.assignedTeam}' does not exist.`);
    }

    // --- Loop 1: Planning & Risk Gate ---
    const riskAssessment = this.evaluateTaskRisk(task);
    task.riskLevel = riskAssessment.level;

    // Inject risk awareness into task context
    task.context = {
      ...task.context,
      riskAssessment,
      projectRoot: this.projectRoot
    };

    // --- Loop 2: Execution & Output Verification ---
    const result = await team.execute(task);
    result.riskEvaluated = riskAssessment;

    // Salience-filtered memory recording
    try {
      await this.memory.recordEpisode({
        ticketId: task.taskId,
        targetFile: task.context.targetFile || 'system',
        title: task.expectedOutput,
        verdict: result.status === 'done' ? 'pass' : 'fail',
        diffSummary: JSON.stringify(result.output).slice(0, 300),
        rationale: result.notes,
        reviewerNotes: riskAssessment.reasons.length > 0 ? `Risk factors: ${riskAssessment.reasons.join('; ')}` : undefined
      });
    } catch {
      // Memory recording non-blocking
    }

    return result;
  }

  public getSkillRegistry(): SkillRegistry {
    return this.registry;
  }

  /**
   * Helper to determine team for a task type.
   */
  public static resolveTeam(taskType: string): TeamName {
    const lower = taskType.toLowerCase();
    if (lower.includes('bug') || lower.includes('debug') || lower.includes('fix') || lower.includes('error') || lower.includes('security')) {
      return 'debugging';
    }
    if (lower.includes('deploy') || lower.includes('release') || lower.includes('ci') || lower.includes('infra')) {
      return 'deployment';
    }
    return 'production';
  }
}
