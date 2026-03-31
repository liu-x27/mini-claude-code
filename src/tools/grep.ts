import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { glob } from "glob";
import type { ToolContext, ToolResult } from "../types.js";
import { Tool } from "./base.js";

const execAsync = promisify(exec);

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  "-i"?: boolean;
  "-A"?: number;
  "-B"?: number;
  output_mode?: "content" | "files_with_matches" | "count";
  head_limit?: number;
}

/** Search file contents using regex. Falls back to pure Node.js if rg is unavailable. */
export class GrepTool extends Tool<GrepInput> {
  readonly name = "Grep";
  readonly description =
    "Search file contents using regex. Returns matching lines with file paths and line numbers. " +
    "Use `glob` to filter by file type (e.g., '*.ts'). " +
    "Use `output_mode: 'files_with_matches'` for just file paths.";

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      pattern: {
        type: "string" as const,
        description: "Regular expression pattern to search for",
      },
      path: {
        type: "string" as const,
        description: "Directory or file to search in (defaults to agent cwd)",
      },
      glob: {
        type: "string" as const,
        description: "File glob filter (e.g., '*.ts', '**/*.json')",
      },
      "-i": {
        type: "boolean" as const,
        description: "Case-insensitive search",
      },
      "-A": {
        type: "number" as const,
        description: "Lines of context after each match",
      },
      "-B": {
        type: "number" as const,
        description: "Lines of context before each match",
      },
      output_mode: {
        type: "string" as const,
        enum: ["content", "files_with_matches", "count"],
        description: "Output format (default: content)",
      },
      head_limit: {
        type: "number" as const,
        description: "Limit output to first N results (default: 250)",
      },
    },
    required: ["pattern"],
  };

  override async execute(input: GrepInput, context: ToolContext): Promise<ToolResult> {
    const searchPath = input.path
      ? path.resolve(context.cwd, input.path)
      : context.cwd;

    // Try rg first, fall back to Node.js implementation
    const rgPath = await this.findRg();
    if (rgPath) {
      return this.execRg(rgPath, input, searchPath, context);
    }
    return this.jsGrep(input, searchPath);
  }

  // ─────────────────────────────────────────────
  // rg-based implementation
  // ─────────────────────────────────────────────

  private async execRg(
    rgPath: string,
    input: GrepInput,
    searchPath: string,
    context: ToolContext
  ): Promise<ToolResult> {
    const headLimit = input.head_limit ?? 250;
    const normalized = searchPath.replace(/\\/g, "/");
    const cmd = this.buildRgCmd(rgPath, input, normalized);

    try {
      const { stdout } = await execAsync(cmd, {
        cwd: context.cwd,
        maxBuffer: 5 * 1024 * 1024,
        env: { ...process.env },
      });

      const lines = stdout.trim().split("\n").filter(Boolean);
      if (lines.length === 0) return { type: "success", output: "No matches found." };

      const truncated = lines.slice(0, headLimit);
      const suffix = lines.length > headLimit ? `\n[... ${lines.length - headLimit} more]` : "";
      return { type: "success", output: truncated.join("\n") + suffix };
    } catch (err: unknown) {
      const e = err as { code?: number; stdout?: string };
      if (e.code === 1) return { type: "success", output: "No matches found." };
      return this.jsGrep(input, searchPath); // fallback on error
    }
  }

  private buildRgCmd(rgPath: string, input: GrepInput, normalizedPath: string): string {
    const parts = [`"${rgPath}"`, "--no-heading", "-n"];
    if (input["-i"]) parts.push("-i");
    if (input["-A"]) parts.push(`-A ${input["-A"]}`);
    if (input["-B"]) parts.push(`-B ${input["-B"]}`);
    if (input.output_mode === "files_with_matches") parts.push("-l");
    else if (input.output_mode === "count") parts.push("-c");
    if (input.glob) parts.push(`--glob "${input.glob}"`);
    parts.push("--glob '!node_modules/**'");
    parts.push("--glob '!.git/**'");
    parts.push("--glob '!dist/**'");
    parts.push(`-- ${JSON.stringify(input.pattern)} "${normalizedPath}"`);
    return parts.join(" ");
  }

  // ─────────────────────────────────────────────
  // Pure Node.js fallback
  // ─────────────────────────────────────────────

  private async jsGrep(input: GrepInput, searchPath: string): Promise<ToolResult> {
    const headLimit = input.head_limit ?? 250;
    const flags = input["-i"] ? "i" : "";
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, flags);
    } catch (e) {
      return { type: "error", message: `Invalid regex: ${String(e)}` };
    }

    // Resolve files to search
    const globPattern = input.glob ?? "**/*";
    let files: string[];
    try {
      const stat = await fs.stat(searchPath);
      if (stat.isFile()) {
        files = [searchPath];
      } else {
        files = (await glob(globPattern, {
          cwd: searchPath,
          absolute: true,
          nodir: true,
          ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
        })) as string[];
      }
    } catch {
      return { type: "error", message: `Path not found: ${searchPath}` };
    }

    const matches: string[] = [];
    const filesWithMatches: string[] = [];
    const counts: Array<[string, number]> = [];

    for (const file of files) {
      let content: string;
      try {
        content = await fs.readFile(file, "utf-8");
      } catch {
        continue; // Skip binary / unreadable files
      }

      const lines = content.split("\n");
      let fileMatchCount = 0;

      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i] ?? "")) {
          fileMatchCount++;
          const lineNum = i + 1;
          const before = input["-B"] ?? 0;
          const after = input["-A"] ?? 0;

          if (input.output_mode !== "files_with_matches" && input.output_mode !== "count") {
            // Add context lines before
            for (let b = Math.max(0, i - before); b < i; b++) {
              matches.push(`${file}:${b + 1}-${lines[b] ?? ""}`);
            }
            matches.push(`${file}:${lineNum}:${lines[i] ?? ""}`);
            // Add context lines after
            for (let a = i + 1; a <= Math.min(lines.length - 1, i + after); a++) {
              matches.push(`${file}:${a + 1}-${lines[a] ?? ""}`);
            }
          }
        }
      }

      if (fileMatchCount > 0) {
        filesWithMatches.push(file);
        counts.push([file, fileMatchCount]);
      }
    }

    if (input.output_mode === "files_with_matches") {
      if (filesWithMatches.length === 0) return { type: "success", output: "No matches found." };
      return { type: "success", output: filesWithMatches.slice(0, headLimit).join("\n") };
    }

    if (input.output_mode === "count") {
      if (counts.length === 0) return { type: "success", output: "No matches found." };
      return {
        type: "success",
        output: counts
          .slice(0, headLimit)
          .map(([f, c]) => `${f}:${c}`)
          .join("\n"),
      };
    }

    if (matches.length === 0) return { type: "success", output: "No matches found." };
    const truncated = matches.slice(0, headLimit);
    const suffix = matches.length > headLimit ? `\n[... ${matches.length - headLimit} more]` : "";
    return { type: "success", output: truncated.join("\n") + suffix };
  }

  // ─────────────────────────────────────────────
  // rg discovery
  // ─────────────────────────────────────────────

  private rgPathCache: string | null | undefined = undefined;

  private async findRg(): Promise<string | null> {
    if (this.rgPathCache !== undefined) return this.rgPathCache;

    // Common install locations
    const candidates = [
      "rg",
      "C:/Program Files/ripgrep/rg.exe",
      `${process.env["APPDATA"]}/ripgrep/rg.exe`,
      `${process.env["LOCALAPPDATA"]}/ripgrep/rg.exe`,
      // Claude Code bundled rg
      `${process.env["APPDATA"]}/npm/node_modules/@anthropic-ai/claude-code/vendor/rg.exe`,
    ];

    for (const candidate of candidates) {
      try {
        await execAsync(`"${candidate}" --version`, {
          timeout: 2000,
          env: { ...process.env },
        });
        this.rgPathCache = candidate;
        return candidate;
      } catch {
        // not available
      }
    }

    this.rgPathCache = null;
    return null;
  }

  override summarize(input: GrepInput): string {
    return `/${input.pattern}/${input.glob ? ` in ${input.glob}` : ""}`;
  }
}
