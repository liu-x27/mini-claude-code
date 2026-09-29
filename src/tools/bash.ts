import * as path from "node:path";
import type { ToolContext, ToolResult } from "../types.js";
import { MAX_TOOL_OUTPUT_CHARS, truncateMiddle } from "../utils/truncate.js";
import { Tool } from "./base.js";
import { resolveShell, runCommand, type Shell } from "./shell.js";

interface BashInput {
  command: string;
  timeout?: number;
  cwd?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;

/**
 * Execute a shell command and return stdout/stderr.
 * This is a dangerous tool — requires permission in non-auto mode.
 */
export class BashTool extends Tool<BashInput> {
  readonly name = "Bash";
  readonly description: string;
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
        description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}, at most ${MAX_TIMEOUT_MS})`,
        default: DEFAULT_TIMEOUT_MS,
      },
      cwd: {
        type: "string" as const,
        description: "Working directory override, relative to the agent cwd (defaults to agent cwd)",
      },
    },
    required: ["command"],
  };

  constructor() {
    super();
    this.description = describe(resolveShell());
  }

  override async execute(input: BashInput, context: ToolContext): Promise<ToolResult> {
    const timeout = Math.min(Math.max(input.timeout ?? DEFAULT_TIMEOUT_MS, 100), MAX_TIMEOUT_MS);
    const workDir = input.cwd ? path.resolve(context.cwd, input.cwd) : context.cwd;

    const run = await runCommand(input.command, { cwd: workDir, timeoutMs: timeout });
    if (run.spawnError) return { type: "error", message: `could not start the shell: ${run.spawnError}` };

    // The tail of a command's output usually says whether it worked, so it gets the larger share.
    const trim = (text: string) => truncateMiddle(text, MAX_TOOL_OUTPUT_CHARS, 0.25);
    const stdout = run.stdout.trim();
    const stderr = run.stderr.trim();
    const parts = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`].filter(Boolean);

    if (run.timedOut) {
      return { type: "error", message: trim([...parts, `timed out after ${timeout} ms; the command was killed`].join("\n\n")) };
    }
    if (run.code !== 0) {
      return { type: "error", message: trim([...parts, `exit code: ${run.code ?? run.signal ?? "unknown"}`].join("\n")) };
    }
    return { type: "success", output: trim(parts.join("\n\n") || "(no output)") };
  }

  override summarize(input: BashInput): string {
    return input.command.slice(0, 80);
  }
}

function describe(shell: Shell): string {
  const where =
    shell.kind === "cmd"
      ? "Commands run in cmd.exe (no bash was found on this Windows machine): use cmd syntax such as dir, type, set and %VAR%."
      : process.platform === "win32"
        ? "Commands run in Git Bash on Windows: use bash syntax; Windows programs are on the PATH as well."
        : `Commands run in ${shell.kind}.`;
  const limit = MAX_TOOL_OUTPUT_CHARS.toLocaleString("en-US");
  return [
    "Execute a shell command in the working directory. Returns stdout and stderr.",
    "Use for running scripts, installing packages, running tests, git operations, etc.",
    where,
    "Prefer short, composable commands. Avoid interactive commands: stdin is closed.",
    `Output longer than ${limit} characters is cut in the middle.`,
  ].join(" ");
}
