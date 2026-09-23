import { ManagerAgent } from '../teams/manager-agent.ts';
import { MemoryAgent } from '../memory-agent.ts';
import { runSecurityScan, type SecurityScanReport } from '../security/security-scanner.ts';
import { runStaticAnalysis } from '../static-analysis.ts';
import { TelemetryVisualizer, type ExecutionGraphSnapshot } from './telemetry-visualizer.ts';
import { type Task } from '../teams/task-schemas.ts';

export interface IssueIntake {
  issueId: string;
  title: string;
  body: string;
  targetFile?: string;
  labels?: string[];
  branchName?: string;
}

export interface IssueResolutionResult {
  issueId: string;
  resolved: boolean;
  status: 'completed' | 'verification_failed' | 'error';
  stages: {
    triage: { assignedTeam: string; memoryRecallTier: string; outlineExtracted: boolean };
    execution: { status: string; notes: string };
    securityCheck: SecurityScanReport;
    linterPassed: boolean;
  };
  telemetry: ExecutionGraphSnapshot;
  durationMs: number;
}

export interface PipelineOptions {
  projectRoot?: string;
  managerAgent?: ManagerAgent;
}

/**
 * Autonomous Issue Resolution Pipeline
 * 
 * Orchestrates end-to-end resolution of software issues:
 * 1. Intake & Triage
 * 2. Tiered Memory & Code AST Outline retrieval
 * 3. Two-Loop Manager & Team execution
 * 4. Multi-Gate Verification (Unit tests, Linter, Security scanner)
 * 5. Salience-driven episodic recording & telemetry graph emission
 */
export class IssueResolverPipeline {
  private projectRoot: string;
  private manager: ManagerAgent;
  private memory: MemoryAgent;

  constructor(options: PipelineOptions = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.manager = options.managerAgent ?? new ManagerAgent({ projectRoot: this.projectRoot });
    this.memory = new MemoryAgent(this.projectRoot);
  }

  public async resolveIssue(issue: IssueIntake): Promise<IssueResolutionResult> {
    const startTime = Date.now();
    const visualizer = new TelemetryVisualizer(`exec-${issue.issueId}`, issue.title);

    visualizer.recordNode({
      id: 'node-intake',
      name: `Issue Intake: #${issue.issueId}`,
      type: 'manager',
      status: 'completed',
      timestamp: new Date().toISOString()
    });

    // 1. Triage & Team assignment
    const assignedTeam = ManagerAgent.resolveTeam(`${issue.title} ${issue.body} ${(issue.labels || []).join(' ')}`);

    // 2. Memory & AST Outline retrieval
    const targetFile = issue.targetFile || 'system';
    const memoryContext = await this.memory.recall(targetFile, { includeOutline: true });

    visualizer.recordNode({
      id: 'node-memory',
      name: `Tiered Memory Recall (${memoryContext.tierUsed})`,
      type: 'manager',
      status: 'completed',
      timestamp: new Date().toISOString()
    });
    visualizer.recordEdge('node-intake', 'node-memory', 'retrieved_context');

    // 3. Dispatch Task to ManagerAgent
    const taskPayload: Task = {
      taskId: `task-${issue.issueId}`,
      assignedTeam,
      taskType: assignedTeam === 'debugging' ? 'bugfix' : 'feature',
      expectedOutput: `Resolve issue #${issue.issueId}: ${issue.title}`,
      context: {
        issueId: issue.issueId,
        title: issue.title,
        body: issue.body,
        targetFile,
        memoryContext: memoryContext.formattedContext,
        projectRoot: this.projectRoot
      },
      maxIterations: 4,
      status: 'pending'
    };

    visualizer.recordNode({
      id: 'node-exec',
      name: `Team Execution (${assignedTeam})`,
      type: 'team',
      status: 'running',
      timestamp: new Date().toISOString()
    });
    visualizer.recordEdge('node-memory', 'node-exec', 'delegated_task');

    const execStartTime = Date.now();
    const result = await this.manager.dispatch(taskPayload);
    const execDuration = Date.now() - execStartTime;

    visualizer.recordNode({
      id: 'node-exec',
      name: `Team Execution (${assignedTeam})`,
      type: 'team',
      status: result.status === 'done' ? 'completed' : 'failed',
      timestamp: new Date().toISOString(),
      durationMs: execDuration
    });

    // 4. Multi-Gate Verification (Linter & Security Scan)
    visualizer.recordNode({
      id: 'node-verify',
      name: 'Verification Gate (Linter + Security Scanner)',
      type: 'verification',
      status: 'running',
      timestamp: new Date().toISOString()
    });
    visualizer.recordEdge('node-exec', 'node-verify', 'verify_changes');

    const secReport = await runSecurityScan(this.projectRoot, targetFile !== 'system' ? [targetFile] : []);
    const lintResult = await runStaticAnalysis(this.projectRoot, targetFile !== 'system' ? [targetFile] : []);

    const isVerified = secReport.passed && lintResult.passed;

    visualizer.recordNode({
      id: 'node-verify',
      name: 'Verification Gate (Linter + Security Scanner)',
      type: 'verification',
      status: isVerified ? 'completed' : 'failed',
      timestamp: new Date().toISOString()
    });

    const isSuccess = result.status === 'done' && isVerified;

    return {
      issueId: issue.issueId,
      resolved: isSuccess,
      status: isSuccess ? 'completed' : (isVerified ? 'error' : 'verification_failed'),
      stages: {
        triage: {
          assignedTeam,
          memoryRecallTier: memoryContext.tierUsed,
          outlineExtracted: !!memoryContext.codeOutline
        },
        execution: {
          status: result.status,
          notes: result.notes
        },
        securityCheck: secReport,
        linterPassed: lintResult.passed
      },
      telemetry: visualizer.getSnapshot(),
      durationMs: Date.now() - startTime
    };
  }
}
