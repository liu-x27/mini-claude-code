import type Anthropic from "@anthropic-ai/sdk";
import type { ToolContext, ToolInputSchema, ToolResult } from "../types.js";

/**
 * Abstract base class for all Agent tools.
 *
 * To create a custom tool, extend this class and implement:
 * - `name`
 * - `description`
 * - `inputSchema`
 * - `execute(input, context)`
 */
export abstract class Tool<TInput extends object = Record<string, unknown>> {
  /** Unique name for this tool (used in API calls) */
  abstract readonly name: string;

  /** Human-readable description used by the LLM to decide when to use this tool */
  abstract readonly description: string;

  /** JSON Schema for the tool's input parameters */
  abstract readonly inputSchema: ToolInputSchema;

  /**
   * Whether this tool performs potentially dangerous operations.
   * Dangerous tools trigger permission checks before execution.
   */
  readonly dangerous: boolean = false;

  /**
   * Execute the tool with the given input.
   * @param input - Validated input matching `inputSchema`
   * @param context - Runtime context (cwd, session info, permissions)
   */
  abstract execute(input: TInput, context: ToolContext): Promise<ToolResult>;

  /**
   * Build the Anthropic SDK tool definition for this tool.
   * Used when constructing the `tools` array for API calls.
   */
  toAnthropicTool(): Anthropic.Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.inputSchema as Anthropic.Tool["input_schema"],
    };
  }

  /** Short summary of a tool call for logging (override for custom formatting) */
  summarize(input: TInput): string {
    const keys = Object.keys(input);
    if (keys.length === 0) return "";
    const first = keys[0];
    if (!first) return "";
    const val = (input as Record<string, unknown>)[first];
    return typeof val === "string" ? val.slice(0, 60) : String(val).slice(0, 60);
  }
}
