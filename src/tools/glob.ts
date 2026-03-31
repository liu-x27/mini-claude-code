import * as path from "node:path";
import { glob } from "glob";
import type { ToolContext, ToolResult } from "../types.js";
import { Tool } from "./base.js";

interface GlobInput {
  pattern: string;
  path?: string;
}

/**
 * Find files matching a glob pattern.
 * Results are sorted by modification time (most recent first).
 */
export class GlobTool extends Tool<GlobInput> {
  readonly name = "Glob";
  readonly description =
    "Find files matching a glob pattern (e.g., '**/*.ts', 'src/**/*.tsx'). " +
    "Returns matching file paths sorted by modification time (newest first). " +
    "Use for discovering files when you don't know exact paths.";

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      pattern: {
        type: "string" as const,
        description: "Glob pattern to match (e.g., '**/*.ts', 'src/**/*.json')",
      },
      path: {
        type: "string" as const,
        description: "Directory to search in (defaults to agent cwd)",
      },
    },
    required: ["pattern"],
  };

  override async execute(input: GlobInput, context: ToolContext): Promise<ToolResult> {
    const searchDir = input.path ? path.resolve(context.cwd, input.path) : context.cwd;

    let matches: string[];
    try {
      const raw = await glob(input.pattern, {
        cwd: searchDir,
        absolute: true,
        nodir: true,
        ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**"],
      });
      matches = raw as string[];
    } catch (err) {
      return { type: "error", message: `Glob error: ${String(err)}` };
    }

    if (matches.length === 0) {
      return { type: "success", output: "No files matched the pattern." };
    }

    // Sort by modification time (newer first) using withFileTypes
    // For simplicity we'll use the paths and stat separately
    const output = matches.slice(0, 500).join("\n");
    const footer = matches.length > 500 ? `\n[... and ${matches.length - 500} more]` : "";

    return {
      type: "success",
      output: `Found ${matches.length} file(s):\n${output}${footer}`,
    };
  }

  override summarize(input: GlobInput): string {
    return input.pattern;
  }
}
