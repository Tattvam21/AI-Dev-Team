export * from './parser.js';
export * from './graph.js';
export const DEPENDENCY_GRAPH_MODULE = "dependency-graph";

export interface FileEdge {
  fromFile: string;
  toFile: string;
  edgeType: "imports" | "calls" | "same_module";
}

export class DependencyGraph {
  private edges: Map<string, Set<string>> = new Map();

  addEdge(from: string, to: string) {
    if (!this.edges.has(from)) {
      this.edges.set(from, new Set());
    }
    this.edges.get(from)!.add(to);
  }

  getNeighbors(file: string): string[] {
    return Array.from(this.edges.get(file) || []);
  }
}
