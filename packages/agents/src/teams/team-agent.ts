import { type Task, type Result, type TeamName, type TeamDecision, TeamDecisionSchema } from './task-schemas.ts';
import { SkillRegistry } from './skill-registry.ts';
import { generateStructured } from '@ai-dev-team/llm-gateway';

export interface TeamExecutionState {
  task: Task;
  iteration: number;
  history: Array<{ action: string; output: any }>;
  isDone: boolean;
  result?: Result;
}

export interface TeamRunnerOptions {
  skillRegistry?: SkillRegistry;
  llmModel?: string;
  llmClient?: any;
}

/**
 * TeamAgent
 *
 * Implements the delegation loop:
 * Receive Task -> Decide Action (Skill vs Sub-delegate vs Complete) -> Execute -> Check Completion -> Loop/Return
 */
export class TeamAgent {
  public readonly teamName: TeamName;
  private registry: SkillRegistry;
  private model: string;
  private llmClient?: any;

  constructor(teamName: TeamName, options: TeamRunnerOptions = {}) {
    this.teamName = teamName;
    this.registry = options.skillRegistry ?? new SkillRegistry();
    this.model = options.llmModel ?? process.env.TEAM_MODEL ?? 'qwen3-coder:30b';
    this.llmClient = options.llmClient;
  }

  /**
   * Executes the delegation loop for a given task.
   */
  public async execute(task: Task): Promise<Result> {
    const state: TeamExecutionState = {
      task,
      iteration: 0,
      history: [],
      isDone: false
    };

    const maxIterations = task.maxIterations || 5;

    while (state.iteration < maxIterations && !state.isDone) {
      state.iteration++;

      // 1. Decide next action using LLM or structured policy
      const decision = await this.decide(state);

      // 2. Act based on decision
      if (decision.action === 'complete') {
        state.isDone = true;
        state.result = {
          taskId: task.taskId,
          status: 'done',
          output: {
            history: state.history,
            summary: decision.rationale
          },
          iterationsUsed: state.iteration,
          notes: decision.rationale
        };
        break;
      } else if (decision.action === 'call_skill' && decision.skillName) {
        try {
          const skillResult = await this.registry.execute(
            decision.skillName,
            this.teamName,
            decision.skillArgs || {},
            { ...task.context, taskId: task.taskId }
          );
          state.history.push({
            action: `call_skill:${decision.skillName}`,
            output: skillResult
          });
        } catch (err: any) {
          state.history.push({
            action: `call_skill_failed:${decision.skillName}`,
            output: { error: err.message }
          });
        }
      } else if (decision.action === 'sub_delegate' && decision.subTask) {
        // Sub-delegate recursively within the team
        const subResult = await this.execute({
          ...decision.subTask,
          assignedTeam: this.teamName,
          parentTaskId: task.taskId,
          maxIterations: Math.max(1, maxIterations - state.iteration)
        });
        state.history.push({
          action: 'sub_delegate',
          output: subResult
        });
        if (subResult.status === 'done') {
          state.isDone = true;
          state.result = subResult;
          break;
        }
      }
    }

    if (!state.result) {
      state.result = {
        taskId: task.taskId,
        status: state.isDone ? 'done' : 'blocked',
        output: { history: state.history },
        iterationsUsed: state.iteration,
        notes: state.isDone ? 'Task finished successfully' : 'Max iterations reached without achieving full expected output.'
      };
    }

    return state.result;
  }

  /**
   * Evaluates current state and selects next action via LLM Gateway.
   */
  private async decide(state: TeamExecutionState): Promise<TeamDecision> {
    const availableSkills = this.registry.getAvailableSkills(this.teamName);
    const skillsSummary = availableSkills.map((s) => `- ${s.name}: ${s.description}`).join('\n');

    const systemPrompt = `You are the lead agent for the '${this.teamName.toUpperCase()}' team.
Your goal is to fulfill the task requirements: "${state.task.expectedOutput}".

Available Skills for your team:
${skillsSummary}

You must respond with valid JSON selecting:
1. 'call_skill' with skillName and skillArgs.
2. 'sub_delegate' with subTask payload if splitting work into a smaller unit.
3. 'complete' when the task's expected output has been fully verified and satisfied.`;

    const userPrompt = `Task Type: ${state.task.taskType}
Context: ${JSON.stringify(state.task.context)}
Iteration: ${state.iteration}/${state.task.maxIterations}
Execution History so far:
${JSON.stringify(state.history, null, 2)}

Select your next action.`;

    try {
      return await generateStructured<TeamDecision>({
        model: this.model,
        systemPrompt,
        userPrompt,
        schema: TeamDecisionSchema,
        client: this.llmClient,
        promptVersion: `team-${this.teamName}/v1`
      });
    } catch {
      // Deterministic fallback if LLM offline / mocking:
      // If memory hasn't been recalled yet, recall it. Else complete.
      const hasRecalled = state.history.some((h) => h.action.includes('memory_recall'));
      if (!hasRecalled) {
        return {
          action: 'call_skill',
          skillName: 'memory_recall',
          skillArgs: { targetFile: state.task.context.targetFile || '' },
          rationale: 'Checking team procedural rules and past episodes before proceeding.'
        };
      }
      return {
        action: 'complete',
        rationale: 'Defaulting to completion based on state requirements.'
      };
    }
  }
}
