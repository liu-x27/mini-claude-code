import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolContext, ToolResult } from "../types.js";
import { Tool } from "./base.js";

interface FileWriteInput {
  file_path: string;
  content: string;
}

/**
 * Create or overwrite a file with given content.
 * Creates parent directories as needed.
 */
export class FileWriteTool extends Tool<FileWriteInput> {
  readonly name = "Write";
  readonly description =
    "Write content to a file, creating it (and any parent directories) if necessary. " +
    "Overwrites existing files. Use Edit for targeted in-place changes to existing files.";
  override readonly dangerous = true;

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      file_path: {
        type: "string" as const,
        description: "Absolute or relative path to the file to write",
      },
      content: {
        type: "string" as const,
        description: "Full content to write to the file",
      },
    },
    required: ["file_path", "content"],
  };

  override async execute(input: FileWriteInput, context: ToolContext): Promise<ToolResult> {
    const absPath = path.resolve(context.cwd, input.file_path);

    try {
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, input.content, "utf-8");
      const lines = input.content.split("\n").length;
      return {
        type: "success",
        output: `Written ${lines} lines to ${absPath}`,
      };
    } catch (err) {
      return { type: "error", message: `Failed to write file: ${String(err)}` };
    }
  }

  override summarize(input: FileWriteInput): string {
    return input.file_path;
  }
}
