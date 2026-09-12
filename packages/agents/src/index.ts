export * from './static-analysis.js';
export * from './scanner.js';
export * from './triage.js';
export * from './git-worktree.js';
export * from './fixer.js';
export * from './sandbox.js';
export * from './test-writer.js';
export * from './reviewer.js';
export * from './git-sync.js';
export const AGENTS_MODULE = "agents";

export type AgentRole = "scanner" | "triage" | "fixer" | "reviewer" | "test-writer" | "git-sync";

export interface AgentDescriptor {
  role: AgentRole;
  modelTier: "small" | "medium" | "large" | "none";
}
