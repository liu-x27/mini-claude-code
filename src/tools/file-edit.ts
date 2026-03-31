import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolContext, ToolResult } from "../types.js";
import { Tool } from "./base.js";

interface FileEditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/**
 * Make targeted edits to an existing file by replacing exact string occurrences.
 * The old_string must be unique in the file (or use replace_all: true).
 */
export class FileEditTool extends Tool<FileEditInput> {
  readonly name = "Edit";
  readonly description =
    "Edit an existing file by replacing an exact string. " +
    "`old_string` must appear exactly once in the file (unless `replace_all` is true). " +
    "Use Write to create new files or do full rewrites.";
  override readonly dangerous = true;

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      file_path: {
        type: "string" as const,
        description: "Absolute or relative path to the file to edit",
      },
      old_string: {
        type: "string" as const,
        description: "Exact string to find and replace",
      },
      new_string: {
        type: "string" as const,
        description: "Replacement string",
      },
      replace_all: {
        type: "boolean" as const,
        description: "Replace all occurrences (default: false — fails if not unique)",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  };

  override async execute(input: FileEditInput, context: ToolContext): Promise<ToolResult> {
    const absPath = path.resolve(context.cwd, input.file_path);

    let content: string;
    try {
      content = await fs.readFile(absPath, "utf-8");
    } catch {
      return { type: "error", message: `File not found: ${absPath}` };
    }

    const count = content.split(input.old_string).length - 1;

    if (count === 0) {
      return {
        type: "error",
        message: "old_string not found in file. Check your string matches exactly (including whitespace and indentation).",
      };
    }

    if (count > 1 && !input.replace_all) {
      return {
        type: "error",
        message: `old_string appears ${count} times. Provide more context to make it unique, or set replace_all: true.`,
      };
    }

    const updated = input.replace_all
      ? content.split(input.old_string).join(input.new_string)
      : content.replace(input.old_string, input.new_string);

    try {
      await fs.writeFile(absPath, updated, "utf-8");
      const replacements = input.replace_all ? count : 1;
      return {
        type: "success",
        output: `Replaced ${replacements} occurrence(s) in ${absPath}`,
      };
    } catch (err) {
      return { type: "error", message: `Failed to write file: ${String(err)}` };
    }
  }

  override summarize(input: FileEditInput): string {
    return `${input.file_path}: "${input.old_string.slice(0, 30)}"`;
  }
}
