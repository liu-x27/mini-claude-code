import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ToolContext, ToolResult } from "../types.js";
import { Tool } from "./base.js";

const execAsync = promisify(exec);

interface BashInput {
  command: string;
  timeout?: number;
  cwd?: string;
}

/**
 * Execute a shell command and return stdout/stderr.
 * This is a dangerous tool — requires permission in non-auto mode.
 */
export class BashTool extends Tool<BashInput> {
  readonly name = "Bash";
  readonly description =
    "Execute a shell command in the working directory. Returns stdout and stderr. " +
    "Use for running scripts, installing packages, running tests, git operations, etc. " +
    "Prefer short, composable commands. Avoid interactive commands.";
  override readonly dangerous = true;

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      command: {
        type: "string" as const,
        description: "The shell command to execute",
      },
      timeout: {
        type: "number" as const,
        description: "Timeout in milliseconds (default: 30000)",
        default: 30000,
      },
      cwd: {
        type: "string" as const,
        description: "Working directory override (defaults to agent cwd)",
      },
    },
    required: ["command"],
  };

  override async execute(input: BashInput, context: ToolContext): Promise<ToolResult> {
    const timeout = input.timeout ?? 30_000;
    const workDir = input.cwd ?? context.cwd;

    try {
      const { stdout, stderr } = await execAsync(input.command, {
        cwd: workDir,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        env: { ...process.env, FORCE_COLOR: "0" },
      });

      const output = [
        stdout.trim() && `stdout:\n${stdout.trim()}`,
        stderr.trim() && `stderr:\n${stderr.trim()}`,
      ]
        .filter(Boolean)
        .join("\n\n");

      return { type: "success", output: output || "(no output)" };
    } catch (err: unknown) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      const parts = [
        e.stdout?.trim() && `stdout:\n${e.stdout.trim()}`,
        e.stderr?.trim() && `stderr:\n${e.stderr.trim()}`,
        `exit code: ${e.code ?? "unknown"}`,
      ].filter(Boolean);
      return { type: "error", message: parts.join("\n") || String(err) };
    }
  }

  override summarize(input: BashInput): string {
    return input.command.slice(0, 80);
  }
}
