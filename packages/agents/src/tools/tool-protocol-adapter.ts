import { z } from 'zod';

export interface StandardToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  handler: (params: Record<string, any>, context: Record<string, any>) => Promise<any>;
}

/**
 * UniversalToolProtocolAdapter
 * 
 * Provides a standardized adapter allowing dynamic registration and execution
 * of tools following open tool schemas (name, description, inputSchema JSON).
 */
export class UniversalToolProtocolAdapter {
  private dynamicTools = new Map<string, StandardToolDefinition>();

  /**
   * Registers a standard tool definition.
   */
  public registerTool(tool: StandardToolDefinition): void {
    this.dynamicTools.set(tool.name, tool);
  }

  /**
   * Lists all dynamically available standard tools.
   */
  public listTools(): Array<{ name: string; description: string; inputSchema: Record<string, any> }> {
    return Array.from(this.dynamicTools.values()).map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }));
  }

  /**
   * Executes a registered standard tool with parameter validation.
   */
  public async executeTool(name: string, params: Record<string, any>, context: Record<string, any> = {}): Promise<any> {
    const tool = this.dynamicTools.get(name);
    if (!tool) {
      throw new Error(`Tool '${name}' not found in Universal Tool Protocol Adapter.`);
    }

    return await tool.handler(params, context);
  }
}
