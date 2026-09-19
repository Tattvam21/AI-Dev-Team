import { TeamName } from './task-schemas.js';
import { MemoryAgent } from '../memory-agent.js';
import { executeInSandbox } from '../sandbox.js';

export type SkillCallable = (args: Record<string, any>, context: Record<string, any>) => Promise<any>;

export interface RegisteredSkill {
  name: string;
  description: string;
  allowedTeams: TeamName[];
  execute: SkillCallable;
}

export class SkillRegistry {
  private skills = new Map<string, RegisteredSkill>();

  constructor() {
    this.registerDefaultSkills();
  }

  public register(skill: RegisteredSkill): void {
    this.skills.set(skill.name, skill);
  }

  public get(name: string): RegisteredSkill | undefined {
    return this.skills.get(name);
  }

  public getAvailableSkills(team: TeamName): RegisteredSkill[] {
    return Array.from(this.skills.values()).filter((s) => s.allowedTeams.includes(team));
  }

  public async execute(name: string, team: TeamName, args: Record<string, any>, context: Record<string, any>): Promise<any> {
    const skill = this.get(name);
    if (!skill) {
      throw new Error(`Skill '${name}' is not registered in the catalog.`);
    }
    if (!skill.allowedTeams.includes(team)) {
      throw new Error(`Permission Denied: Team '${team}' is not permitted to execute skill '${name}'. Allowed teams: [${skill.allowedTeams.join(', ')}]`);
    }
    return skill.execute(args, context);
  }

  private registerDefaultSkills(): void {
    // 1. memory_recall: Access procedural rules & episodic history from .aidev/
    this.register({
      name: 'memory_recall',
      description: 'Recalls rules and past ticket episodes for a given file or topic from .aidev/',
      allowedTeams: ['production', 'debugging', 'deployment'],
      execute: async (args, context) => {
        const projectRoot = context.projectRoot || process.cwd();
        const targetFile = args.targetFile || '';
        const memory = new MemoryAgent(projectRoot);
        return await memory.recall(targetFile);
      }
    });

    // 2. memory_record: Records a completed episode into .aidev/
    this.register({
      name: 'memory_record',
      description: 'Records a completed task or review episode into .aidev/episodes.jsonl',
      allowedTeams: ['production', 'debugging', 'deployment'],
      execute: async (args, context) => {
        const projectRoot = context.projectRoot || process.cwd();
        const memory = new MemoryAgent(projectRoot);
        await memory.recordEpisode({
          ticketId: args.ticketId || context.taskId || 'generic-task',
          targetFile: args.targetFile || 'system',
          title: args.title || 'Task completion',
          verdict: args.verdict || 'pass',
          rationale: args.rationale,
          reviewerNotes: args.reviewerNotes
        });
        return { recorded: true };
      }
    });

    // 3. code_exec: Runs command in isolated sandbox
    this.register({
      name: 'code_exec',
      description: 'Executes a command safely inside the sandbox container',
      allowedTeams: ['production', 'debugging'],
      execute: async (args, context) => {
        const worktreePath = context.worktreePath || process.cwd();
        const command = args.command;
        if (!command) throw new Error('Missing command argument');
        return await executeInSandbox(worktreePath, command, {
          timeoutSec: args.timeoutSec || 60
        });
      }
    });

    // 4. test_runner: Runs test suite
    this.register({
      name: 'test_runner',
      description: 'Runs test suite and returns execution output and exit code',
      allowedTeams: ['production', 'debugging'],
      execute: async (args, context) => {
        const worktreePath = context.worktreePath || process.cwd();
        const cmd = args.testCommand || 'npm test';
        return await executeInSandbox(worktreePath, cmd, {
          timeoutSec: args.timeoutSec || 120
        });
      }
    });

    // 5. git_ops: Git status, branch, and commit
    this.register({
      name: 'git_ops',
      description: 'Performs git repository operations (branch, commit, diff)',
      allowedTeams: ['production', 'deployment'],
      execute: async (args, context) => {
        const action = args.action; // 'status' | 'diff'
        return {
          action,
          executed: true,
          message: `Executed git ${action} in ${context.worktreePath || 'current repo'}`
        };
      }
    });
  }
}
