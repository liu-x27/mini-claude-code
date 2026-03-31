import type { Tool } from "./base.js";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any>;

/**
 * Central registry for all available tools.
 * Supports registering, unregistering, and resolving tools by name.
 */
export class ToolRegistry {
  private tools = new Map<string, AnyTool>();

  /** Register one or more tools */
  register(...tools: AnyTool[]): this {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(`Tool "${tool.name}" is already registered`);
      }
      this.tools.set(tool.name, tool);
    }
    return this;
  }

  /** Unregister a tool by name */
  unregister(name: string): this {
    this.tools.delete(name);
    return this;
  }

  /** Get a tool by name */
  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  /** Check if a tool is registered */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** List all registered tool names */
  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Get all registered tools */
  all(): AnyTool[] {
    return [...this.tools.values()];
  }

  /**
   * Resolve a subset of tools by name.
   * @param allowed - If provided, only return tools in this list
   * @param disallowed - Tool names to exclude
   */
  resolve(allowed?: string[], disallowed?: string[]): AnyTool[] {
    let tools = this.all();
    if (allowed && allowed.length > 0) {
      tools = tools.filter((t) => allowed.includes(t.name));
    }
    if (disallowed && disallowed.length > 0) {
      tools = tools.filter((t) => !disallowed.includes(t.name));
    }
    return tools;
  }
}

/** Global default registry — populated with built-in tools in tools/index.ts */
export const globalRegistry = new ToolRegistry();
