import type { SubagentDefinition, ToolContext, ToolResult } from "../types.js";
import { Tool } from "./base.js";

interface TaskInput {
  description: string;
  prompt: string;
  subagent_type?: string;
}

/** Runs a subagent and resolves to its final text, or throws. Supplied by the Agent that owns the tool. */
export type SubagentRunner = (type: string, prompt: string) => Promise<{ text: string; stopReason: string }>;

export const GENERAL_PURPOSE = "general-purpose";

/**
 * Hand a self-contained task to a subagent with a fresh context.
 *
 * What the subagent reads and tries stays in its own context; only its final
 * answer comes back, so a search across many files costs the parent one
 * result instead of every file. It is a dangerous tool, so subagents run one
 * at a time: two editing the same files at once would be the race the loop's
 * scheduling exists to prevent.
 */
export class TaskTool extends Tool<TaskInput> {
  readonly name = "Task";
  readonly description: string;
  override readonly dangerous = true;
  readonly inputSchema;

  constructor(
    private types: Record<string, SubagentDefinition>,
    private runSubagent: SubagentRunner,
  ) {
    super();
    const names = [GENERAL_PURPOSE, ...Object.keys(types).filter((t) => t !== GENERAL_PURPOSE)];
    const listing = [
      `- ${GENERAL_PURPOSE}: any task, with every tool but this one.`,
      ...Object.entries(types)
        .filter(([t]) => t !== GENERAL_PURPOSE)
        .map(([t, d]) => `- ${t}: ${d.description}`),
    ].join("\n");
    const intro = [
      "Hand a self-contained task to a subagent with a fresh context, and get back only its final answer.",
      "Use it for work that would fill this conversation with reading — searching a codebase, surveying files —",
      "and give it everything it needs in the prompt, since it sees nothing of this conversation. Types:",
    ].join(" ");
    this.description = `${intro}\n${listing}`;
    this.inputSchema = {
      type: "object" as const,
      properties: {
        description: { type: "string" as const, description: "A few words saying what the task is" },
        prompt: { type: "string" as const, description: "The whole task, self-contained" },
        subagent_type: {
          type: "string" as const,
          enum: names,
          description: `Which subagent (default ${GENERAL_PURPOSE})`,
        },
      },
      required: ["description", "prompt"],
    };
  }

  override async execute(input: TaskInput, _context: ToolContext): Promise<ToolResult> {
    const type = input.subagent_type ?? GENERAL_PURPOSE;
    if (type !== GENERAL_PURPOSE && !this.types[type]) return { type: "error", message: `No subagent type "${type}"` };
    const result = await this.runSubagent(type, input.prompt);
    if (result.stopReason === "end_turn") return { type: "success", output: result.text || "(the subagent gave no answer)" };
    return {
      type: "error",
      message: `The subagent stopped early (${result.stopReason})${result.text ? `: ${result.text}` : ""}`,
    };
  }

  override summarize(input: TaskInput): string {
    return `${input.subagent_type ?? GENERAL_PURPOSE}: ${input.description}`;
  }
}
