import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolContext, ToolResult } from "../types.js";
import { Tool } from "./base.js";

interface FileReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

const MAX_LINES = 2000;
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Read a file from disk, with optional line range.
 * Returns content with 1-based line numbers (cat -n style).
 */
export class FileReadTool extends Tool<FileReadInput> {
  readonly name = "Read";
  readonly description =
    "Read a file from the filesystem. Returns file content with line numbers. " +
    "Use `offset` and `limit` to read specific line ranges for large files. " +
    "Supports text files; binary files return a summary instead.";

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      file_path: {
        type: "string" as const,
        description: "Absolute or relative path to the file to read",
      },
      offset: {
        type: "number" as const,
        description: "Line number to start reading from (1-based, default: 1)",
      },
      limit: {
        type: "number" as const,
        description: `Maximum number of lines to read (default: ${MAX_LINES})`,
      },
    },
    required: ["file_path"],
  };

  override async execute(input: FileReadInput, context: ToolContext): Promise<ToolResult> {
    const absPath = path.resolve(context.cwd, input.file_path);

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(absPath);
    } catch {
      return { type: "error", message: `File not found: ${absPath}` };
    }

    if (stat.size > MAX_BYTES) {
      return {
        type: "error",
        message: `File is too large (${(stat.size / 1024).toFixed(0)} KB). Use offset/limit to read in chunks.`,
      };
    }

    let raw: string;
    try {
      raw = await fs.readFile(absPath, "utf-8");
    } catch {
      return { type: "error", message: `Cannot read file as text: ${absPath}` };
    }

    const lines = raw.split("\n");
    const startLine = Math.max(1, input.offset ?? 1);
    const maxLines = input.limit ?? MAX_LINES;
    const slice = lines.slice(startLine - 1, startLine - 1 + maxLines);

    const numbered = slice
      .map((line, i) => `${String(startLine + i).padStart(4, " ")}\t${line}`)
      .join("\n");

    const totalLines = lines.length;
    const endLine = startLine - 1 + slice.length;
    const footer =
      endLine < totalLines
        ? `\n\n[Showing lines ${startLine}–${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.]`
        : "";

    return { type: "success", output: numbered + footer };
  }

  override summarize(input: FileReadInput): string {
    return input.file_path;
  }
}
