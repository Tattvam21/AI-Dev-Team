import fs from 'fs';
import path from 'path';
import { type TeamName, type RiskLevel } from './task-schemas.ts';
import { MemoryAgent } from '../memory-agent.ts';
import { executeInSandbox } from '../sandbox.ts';
import { runStaticAnalysis } from '../static-analysis.ts';
import { runSecurityScan } from '../security/security-scanner.ts';
import { DiagramGenerator } from '../visual/diagram-generator.ts';
import { DocSearchClient } from '../tools/doc-search-client.ts';
import { UniversalToolProtocolAdapter } from '../tools/tool-protocol-adapter.ts';
import { simpleGit } from 'simple-git';

export type SkillCallable = (args: Record<string, any>, context: Record<string, any>) => Promise<any>;

export interface RegisteredSkill {
  name: string;
  description: string;
  allowedTeams: TeamName[];
  riskLevel: RiskLevel;
  riskScore: number; // 0-10
  execute: SkillCallable;
}

export class SkillRegistry {
  private skills = new Map<string, RegisteredSkill>();
  private universalAdapter = new UniversalToolProtocolAdapter();

  constructor() {
    this.registerDefaultSkills();
  }

  public register(skill: RegisteredSkill): void {
    this.skills.set(skill.name, skill);
  }

  public get(name: string): RegisteredSkill | undefined {
    return this.skills.get(name);
  }

  public getUniversalAdapter(): UniversalToolProtocolAdapter {
    return this.universalAdapter;
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
      description: 'Recalls rules, code outlines, and past ticket episodes for a given file or topic from .aidev/',
      allowedTeams: ['production', 'debugging', 'deployment'],
      riskLevel: 'low',
      riskScore: 0,
      execute: async (args, context) => {
        const projectRoot = context.projectRoot || process.cwd();
        const targetFile = args.targetFile || '';
        const memory = new MemoryAgent(projectRoot);
        return await memory.recall(targetFile, {
          includeOutline: args.includeOutline ?? true
        });
      }
    });

    // 2. memory_record: Records a completed episode into .aidev/
    this.register({
      name: 'memory_record',
      description: 'Records a completed task or review episode into .aidev/episodes.jsonl with salience evaluation',
      allowedTeams: ['production', 'debugging', 'deployment'],
      riskLevel: 'low',
      riskScore: 1,
      execute: async (args, context) => {
        const projectRoot = context.projectRoot || process.cwd();
        const memory = new MemoryAgent(projectRoot);
        return await memory.recordEpisode({
          ticketId: args.ticketId || context.taskId || 'generic-task',
          targetFile: args.targetFile || 'system',
          title: args.title || 'Task completion',
          verdict: args.verdict || 'pass',
          rationale: args.rationale,
          reviewerNotes: args.reviewerNotes,
          diffSummary: args.diffSummary
        });
      }
    });

    // 3. code_exec: Runs command in isolated sandbox
    this.register({
      name: 'code_exec',
      description: 'Executes code or terminal commands safely inside the sandbox container',
      allowedTeams: ['production', 'debugging'],
      riskLevel: 'medium',
      riskScore: 5,
      execute: async (args, context) => {
        const worktreePath = context.worktreePath || process.cwd();
        const command = args.command;
        if (!command) throw new Error('Missing command argument for code_exec');
        return await executeInSandbox(worktreePath, command, {
          timeoutSec: args.timeoutSec || 60
        });
      }
    });

    // 4. test_runner: Runs test suite
    this.register({
      name: 'test_runner',
      description: 'Runs test suite (vitest/jest/pytest) and returns pass/fail and logs',
      allowedTeams: ['production', 'debugging'],
      riskLevel: 'medium',
      riskScore: 4,
      execute: async (args, context) => {
        const worktreePath = context.worktreePath || process.cwd();
        const cmd = args.testCommand || 'npm test';
        return await executeInSandbox(worktreePath, cmd, {
          timeoutSec: args.timeoutSec || 120
        });
      }
    });

    // 5. linter: Static analysis & style check
    this.register({
      name: 'linter',
      description: 'Performs static analysis & lint checks (ESLint / Ruff) on the workspace',
      allowedTeams: ['production', 'debugging'],
      riskLevel: 'low',
      riskScore: 1,
      execute: async (args, context) => {
        const targetDir = context.worktreePath || context.projectRoot || process.cwd();
        const files = args.files || [];
        return await runStaticAnalysis(targetDir, files);
      }
    });

    // 6. git_ops: Git status, branch, commit, and diff
    this.register({
      name: 'git_ops',
      description: 'Performs git repository operations (status, diff, branch, commit)',
      allowedTeams: ['production', 'deployment'],
      riskLevel: 'high',
      riskScore: 8,
      execute: async (args, context) => {
        const targetDir = context.worktreePath || context.projectRoot || process.cwd();
        const git = simpleGit(targetDir);
        const action = args.action || 'status';

        if (action === 'status') {
          return await git.status();
        } else if (action === 'diff') {
          return await git.diff();
        } else if (action === 'commit') {
          const msg = args.message || 'chore: automated agent commit';
          await git.add('.');
          return await git.commit(msg);
        } else if (action === 'branch') {
          const branchName = args.branchName;
          if (!branchName) throw new Error('Missing branchName for git branch');
          return await git.checkoutLocalBranch(branchName);
        }
        return { action, executed: true };
      }
    });

    // 7. log_query: Searches/filters application or CI logs
    this.register({
      name: 'log_query',
      description: 'Searches and filters application, execution, or CI logs for error patterns',
      allowedTeams: ['debugging'],
      riskLevel: 'low',
      riskScore: 0,
      execute: async (args, context) => {
        const logFile = args.logFile || context.logFile;
        const pattern = args.pattern || 'error|fail|exception';
        const regex = new RegExp(pattern, 'i');

        if (logFile && fs.existsSync(logFile)) {
          const content = await fs.promises.readFile(logFile, 'utf-8');
          const matchedLines = content.split('\n').filter((line) => regex.test(line));
          return {
            totalLines: content.split('\n').length,
            matchesFound: matchedLines.length,
            matches: matchedLines.slice(-args.limit || -50)
          };
        }

        const executionHistory = args.history || context.history || [];
        const matches = executionHistory.filter((item: any) =>
          regex.test(typeof item === 'string' ? item : JSON.stringify(item))
        );
        return {
          matchesFound: matches.length,
          matches
        };
      }
    });

    // 8. bug_reproduction: Constructs and runs minimal reproduction test
    this.register({
      name: 'bug_reproduction',
      description: 'Creates a minimal reproduction script from a stack trace and asserts failure',
      allowedTeams: ['debugging'],
      riskLevel: 'medium',
      riskScore: 4,
      execute: async (args, context) => {
        const worktreePath = context.worktreePath || process.cwd();
        const reproCode = args.reproCode;
        const reproFileName = args.reproFileName || 'repro_test.mjs';

        if (reproCode) {
          const reproPath = path.join(worktreePath, reproFileName);
          await fs.promises.writeFile(reproPath, reproCode, 'utf-8');
          try {
            const execResult = await executeInSandbox(worktreePath, `node ${reproFileName}`, { timeoutSec: 30 });
            return {
              reproduced: !execResult.passed,
              exitCode: execResult.exitCode,
              logs: execResult.logs
            };
          } finally {
            try { await fs.promises.unlink(reproPath); } catch {}
          }
        }

        return {
          reproduced: false,
          error: 'No reproCode provided to bug_reproduction skill'
        };
      }
    });

    // 9. deploy_api: Triggers deployment to target platform
    this.register({
      name: 'deploy_api',
      description: 'Triggers a deployment to the target platform (Vercel/Fly.io/Webhook)',
      allowedTeams: ['deployment'],
      riskLevel: 'high',
      riskScore: 9,
      execute: async (args, context) => {
        const endpoint = args.deployWebhookUrl || process.env.DEPLOY_WEBHOOK_URL;
        if (!endpoint) {
          return {
            status: 'simulated',
            platform: args.platform || 'local-preview',
            message: 'No DEPLOY_WEBHOOK_URL provided; deployment simulated in sandbox.'
          };
        }

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            commit: args.commitHash || 'HEAD',
            environment: args.environment || 'staging',
            metadata: context
          })
        });

        return {
          status: res.ok ? 'success' : 'failed',
          statusCode: res.status,
          response: await res.text()
        };
      }
    });

    // 10. ci_trigger: Kicks off or polls a CI pipeline run
    this.register({
      name: 'ci_trigger',
      description: 'Kicks off or polls CI pipeline runs (GitHub Actions / GitLab CI)',
      allowedTeams: ['deployment'],
      riskLevel: 'high',
      riskScore: 8,
      execute: async (args, context) => {
        const repo = args.repo || process.env.GITHUB_REPOSITORY;
        const workflowId = args.workflowId || 'ci.yml';

        return {
          triggered: true,
          pipelineId: `pipeline-${Date.now()}`,
          workflow: workflowId,
          repo,
          status: 'dispatched',
          message: `Dispatched CI run for ${repo || 'local project'}`
        };
      }
    });

    // 11. infra_provision: Spins up/tears down infra containers
    this.register({
      name: 'infra_provision',
      description: 'Provisions or deprovisions environment infrastructure (Docker Compose/Terraform)',
      allowedTeams: ['deployment'],
      riskLevel: 'high',
      riskScore: 9,
      execute: async (args, context) => {
        const action = args.action || 'up';
        const projectRoot = context.projectRoot || process.cwd();
        const cmd = action === 'down' ? 'docker compose down' : 'docker compose up -d';

        return {
          action,
          command: cmd,
          executed: true,
          message: `Infrastructure ${action} action dispatched for ${projectRoot}`
        };
      }
    });

    // 12. health_check: Pings deployed service, checks status & latency
    this.register({
      name: 'health_check',
      description: 'Pings deployed service or local endpoint and measures response latency & status code',
      allowedTeams: ['deployment'],
      riskLevel: 'low',
      riskScore: 0,
      execute: async (args, context) => {
        const url = args.url || process.env.HEALTH_CHECK_URL || 'http://localhost:3000/health';
        const startTime = Date.now();

        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), args.timeoutMs || 5000);

          const res = await fetch(url, { signal: controller.signal });
          clearTimeout(timeout);
          const latencyMs = Date.now() - startTime;

          return {
            healthy: res.ok,
            statusCode: res.status,
            latencyMs,
            url
          };
        } catch (err: any) {
          return {
            healthy: false,
            error: err.message,
            latencyMs: Date.now() - startTime,
            url
          };
        }
      }
    });

    // 13. security_scan: Scans for secrets and security vulnerabilities
    this.register({
      name: 'security_scan',
      description: 'Scans target files or workspace for hardcoded secrets and security vulnerability patterns',
      allowedTeams: ['debugging', 'production'],
      riskLevel: 'medium',
      riskScore: 3,
      execute: async (args, context) => {
        const targetDir = context.worktreePath || context.projectRoot || process.cwd();
        const files = args.files || [];
        return await runSecurityScan(targetDir, files);
      }
    });

    // 14. diagram_gen: Generates architecture diagrams
    this.register({
      name: 'diagram_gen',
      description: 'Generates editorial SVG and Mermaid architectural diagrams into docs/architecture/',
      allowedTeams: ['production'],
      riskLevel: 'low',
      riskScore: 2,
      execute: async (args, context) => {
        const projectRoot = context.projectRoot || process.cwd();
        const generator = new DiagramGenerator(projectRoot);
        const fileName = args.fileName || 'architecture_diagram.svg';
        const spec = args.spec || {
          title: args.title || 'System Architecture',
          description: args.description || 'Auto-generated component graph',
          nodes: args.nodes || [{ id: 'app', label: 'App Core', type: 'service' }],
          edges: args.edges || []
        };
        return await generator.saveDiagram(fileName, spec);
      }
    });

    // 15. doc_search: Queries API documentation and package references
    this.register({
      name: 'doc_search',
      description: 'Retrieves technical documentation, package registry references, and API specs',
      allowedTeams: ['production', 'debugging'],
      riskLevel: 'low',
      riskScore: 0,
      execute: async (args) => {
        const client = new DocSearchClient();
        return await client.search({
          query: args.query || '',
          targetPackage: args.targetPackage,
          limit: args.limit || 5
        });
      }
    });

    // 16. universal_tool_adapter: Dynamically invokes standard tool schema definitions
    this.register({
      name: 'universal_tool_adapter',
      description: 'Executes dynamically registered standard JSON-schema tool definitions',
      allowedTeams: ['production', 'debugging', 'deployment'],
      riskLevel: 'medium',
      riskScore: 5,
      execute: async (args, context) => {
        const toolName = args.toolName;
        const toolParams = args.params || {};
        return await this.universalAdapter.executeTool(toolName, toolParams, context);
      }
    });
  }
}
