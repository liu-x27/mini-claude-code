import type Anthropic from "@anthropic-ai/sdk";
import type { ToolContext, ToolInputSchema, ToolResult } from "../types.js";
import { type Validated, validateInput } from "./validate.js";

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
   *
   * It also decides scheduling: calls to tools that are not dangerous run
   * concurrently, and a dangerous call runs alone, in the order the model
   * made it. Two Edits of one file in the same turn used to run at once, and
   * one of them was lost more often than not while both reported success.
   */
  readonly dangerous: boolean = false;

  /**
   * How a result longer than the output limit is cut: the share of the budget
   * kept from the start. The rest of the text is saved to a file whose path
   * the model is given.
   */
  readonly outputHeadShare: number = 0.5;

  /**
   * Said instead of saving the whole text, for a tool whose output can simply
   * be asked for again in pieces.
   */
  readonly rereadHint: string | undefined = undefined;

  /**
   * Execute the tool with the given input.
   * @param input - Input that has passed `validate()` against `inputSchema`
   * @param context - Runtime context (cwd, session info, permissions)
   */
  abstract execute(input: TInput, context: ToolContext): Promise<ToolResult>;

  /** Check a call's input against `inputSchema`; the agent loop runs this before `execute`. */
  validate(input: unknown): Validated {
    return validateInput(this.inputSchema, input);
  }

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
