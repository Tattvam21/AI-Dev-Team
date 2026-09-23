export * from './static-analysis.js';
export * from './scanner.js';
export * from './triage.js';
export * from './git-worktree.js';
export * from './fixer.js';
export * from './sandbox.js';
export * from './test-writer.js';
export * from './reviewer.js';
export * from './git-sync.js';
export * from './memory-agent.js';
export * from './memory/code-ast-outline.js';
export * from './security/security-scanner.js';
export * from './visual/diagram-generator.js';
export * from './tools/doc-search-client.js';
export * from './tools/tool-protocol-adapter.js';
export * from './workflows/telemetry-visualizer.js';
export * from './workflows/issue-resolver-pipeline.js';
export * from './teams/index.js';

export const AGENTS_MODULE = "agents";

export type AgentRole = "scanner" | "triage" | "fixer" | "reviewer" | "test-writer" | "git-sync";

export interface AgentDescriptor {
  role: AgentRole;
  modelTier: "small" | "medium" | "large" | "none";
}
