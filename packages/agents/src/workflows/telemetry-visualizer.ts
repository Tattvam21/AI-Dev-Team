export interface TelemetryNode {
  id: string;
  name: string;
  type: 'manager' | 'team' | 'skill' | 'verification';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  timestamp: string;
  durationMs?: number;
  metadata?: Record<string, any>;
}

export interface TelemetryEdge {
  from: string;
  to: string;
  action: string;
}

export interface ExecutionGraphSnapshot {
  executionId: string;
  rootTask: string;
  startedAt: string;
  completedAt?: string;
  nodes: TelemetryNode[];
  edges: TelemetryEdge[];
  summary: {
    totalNodes: number;
    completed: number;
    failed: number;
    totalDurationMs: number;
  };
}

/**
 * TelemetryVisualizer
 * 
 * Captures real-time agent execution traces and formats them into structured
 * execution graphs for visual UI dashboards and terminal ASCII views.
 */
export class TelemetryVisualizer {
  private executionId: string;
  private rootTask: string;
  private startedAt: string;
  private nodes = new Map<string, TelemetryNode>();
  private edges: TelemetryEdge[] = [];

  constructor(executionId: string, rootTask: string) {
    this.executionId = executionId;
    this.rootTask = rootTask;
    this.startedAt = new Date().toISOString();
  }

  public recordNode(node: TelemetryNode): void {
    this.nodes.set(node.id, node);
  }

  public recordEdge(from: string, to: string, action: string): void {
    this.edges.push({ from, to, action });
  }

  public getSnapshot(): ExecutionGraphSnapshot {
    const nodeList = Array.from(this.nodes.values());
    const completed = nodeList.filter(n => n.status === 'completed').length;
    const failed = nodeList.filter(n => n.status === 'failed').length;
    const totalDurationMs = nodeList.reduce((acc, n) => acc + (n.durationMs || 0), 0);

    return {
      executionId: this.executionId,
      rootTask: this.rootTask,
      startedAt: this.startedAt,
      completedAt: new Date().toISOString(),
      nodes: nodeList,
      edges: this.edges,
      summary: {
        totalNodes: nodeList.length,
        completed,
        failed,
        totalDurationMs
      }
    };
  }

  /**
   * Renders a clean ASCII workflow graph for terminal outputs.
   */
  public renderAsciiGraph(): string {
    const lines: string[] = [
      `=== AI Dev Team Execution Telemetry [ID: ${this.executionId}] ===`,
      `Task: ${this.rootTask}`
    ];

    const nodeList = Array.from(this.nodes.values());
    for (const node of nodeList) {
      const statusIcon = node.status === 'completed' ? '✔' : (node.status === 'failed' ? '✖' : '⏳');
      const dur = node.durationMs ? ` (${node.durationMs}ms)` : '';
      lines.push(`  [${statusIcon}] [${node.type.toUpperCase()}] ${node.name}${dur}`);
    }

    if (this.edges.length > 0) {
      lines.push('\nDelegation Transitions:');
      for (const edge of this.edges) {
        lines.push(`  ${edge.from} ──(${edge.action})──> ${edge.to}`);
      }
    }

    return lines.join('\n');
  }
}
