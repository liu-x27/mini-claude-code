import type { TodoItem, ToolContext, ToolResult } from "../types.js";
import { Tool } from "./base.js";

interface TodoInput {
  todos: TodoItem[];
}

const STATUSES = new Set(["pending", "in_progress", "completed"]);
const MARK: Record<TodoItem["status"], string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };

/**
 * The model's own task list, written whole on every call, as Claude Code's
 * TodoWrite and Gemini CLI's write_todos are. It changes nothing on disk;
 * the list is kept with the session and shown to the user.
 */
export class TodoWriteTool extends Tool<TodoInput> {
  readonly name = "TodoWrite";
  readonly description =
    "Keep a task list for work with several steps: pass the whole list each time, with each item pending, " +
    "in_progress or completed. Mark an item in_progress before starting it and completed as soon as it is done; " +
    "at most one item is in_progress. Skip it for a task of one or two steps.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      todos: {
        type: "array" as const,
        description: "The whole list, in order",
        items: {
          type: "object" as const,
          properties: {
            content: { type: "string" as const, description: "What to do" },
            status: { type: "string" as const, enum: ["pending", "in_progress", "completed"] },
          },
        },
      },
    },
    required: ["todos"],
  };

  override async execute(input: TodoInput, context: ToolContext): Promise<ToolResult> {
    const items: TodoItem[] = [];
    for (const [i, raw] of input.todos.entries()) {
      const item = raw as Partial<TodoItem>;
      if (typeof item.content !== "string" || !item.content.trim()) return { type: "error", message: `item ${i + 1} has no content` };
      if (typeof item.status !== "string" || !STATUSES.has(item.status)) {
        return { type: "error", message: `item ${i + 1}: status must be pending, in_progress or completed` };
      }
      items.push({ content: item.content.trim(), status: item.status });
    }
    if (items.filter((t) => t.status === "in_progress").length > 1) {
      return { type: "error", message: "at most one item may be in_progress" };
    }
    context.todos?.set(items);
    const list = items.map((t) => `${MARK[t.status]} ${t.content}`).join("\n");
    return { type: "success", output: items.length > 0 ? `Task list updated:\n${list}` : "Task list cleared." };
  }

  override summarize(input: TodoInput): string {
    const open = input.todos.filter((t) => t.status !== "completed").length;
    return `${input.todos.length} item(s), ${open} open`;
  }
}
