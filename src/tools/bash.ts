import * as path from "node:path";
import type { Sandbox, SandboxedCommand } from "../sandbox/index.js";
import type { ToolContext, ToolInputSchema, ToolResult } from "../types.js";
import { MAX_TOOL_OUTPUT_CHARS } from "../utils/truncate.js";
import { Tool } from "./base.js";
import { type RunOutcome, resolveShell, runCommand, type Shell } from "./shell.js";

interface BashInput {
  command: string;
  timeout?: number;
  cwd?: string;
  /** Offered only when there is a sandbox that lets calls out of it. */
  dangerouslyDisableSandbox?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;

/**
 * Execute a shell command and return stdout/stderr.
 * This is a dangerous tool — requires permission in non-auto mode.
 *
 * Given a sandbox, every command runs inside it unless the call asks to
 * leave it; without one, a command runs as the user, as it always has.
 */
export class BashTool extends Tool<BashInput> {
  readonly name = "Bash";
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
  override readonly dangerous = true;
  // The tail of a command's output usually says whether it worked, so it keeps the larger share when cut.
  override readonly outputHeadShare = 0.25;

  constructor(private readonly sandbox?: Sandbox) {
    super();
    this.description = describe(sandbox?.backend.shell ?? resolveShell(), sandbox);
    this.inputSchema = schema(sandbox);
  }

  override sandboxed(input: BashInput): boolean {
    return this.sandbox?.usable === true && input.dangerouslyDisableSandbox !== true;
  }

  override async execute(input: BashInput, context: ToolContext): Promise<ToolResult> {
    const timeout = Math.min(Math.max(input.timeout ?? DEFAULT_TIMEOUT_MS, 100), MAX_TIMEOUT_MS);
    const workDir = input.cwd ? path.resolve(context.cwd, input.cwd) : context.cwd;
    const sandbox = this.sandbox;
    const leaving = sandbox !== undefined && input.dangerouslyDisableSandbox === true;

    if (leaving && !sandbox.allowUnsandboxed) {
      return {
        type: "error",
        message:
          "Nothing runs outside the sandbox here: dangerouslyDisableSandbox is turned off, and the command did not run. Run it inside the sandbox, or tell the user what it needs and why.",
      };
    }
    let run: RunOutcome;
    if (sandbox && !leaving) {
      // The workspace is the agent's directory, not the call's `cwd`, which can point anywhere.
      let wrapped: SandboxedCommand;
      try {
        wrapped = await sandbox.prepare(input.command, context.cwd, workDir, sandbox.backend.shell ?? resolveShell());
      } catch (err) {
        return {
          type: "error",
          message: `The sandbox could not start this command, so it did not run: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      try {
        run = await runCommand(input.command, { cwd: workDir, timeoutMs: timeout, sandboxed: wrapped });
      } finally {
        await wrapped.cleanup?.().catch(() => undefined);
      }
    } else {
      run = await runCommand(input.command, { cwd: workDir, timeoutMs: timeout });
    }
    if (run.spawnError) return { type: "error", message: `could not start the shell: ${run.spawnError}` };

    // Whole, as far as the capture kept it: the agent loop cuts what the model sees and saves the rest.
    const stdout = run.stdout.trim();
    const stderr = run.stderr.trim();
    const parts = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`].filter(Boolean);

    if (run.timedOut) {
      return { type: "error", message: [...parts, `timed out after ${timeout} ms; the command was killed`].join("\n\n") };
    }
    if (run.code !== 0) {
      const blocked = sandbox && !leaving ? sandbox.backend.explain?.(input.command, stderr) : undefined;
      return {
        type: "error",
        message: [...parts, `exit code: ${run.code ?? run.signal ?? "unknown"}`, ...(blocked ? [`sandbox: ${blocked}`] : [])].join("\n"),
      };
    }
    return { type: "success", output: parts.join("\n\n") || "(no output)" };
  }

  override summarize(input: BashInput): string {
    const command = input.command.slice(0, 80);
    return this.sandbox && input.dangerouslyDisableSandbox === true ? `[outside the sandbox] ${command}` : command;
  }
}

function schema(sandbox: Sandbox | undefined): ToolInputSchema {
  return {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
      timeout: {
        type: "number",
        description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}, at most ${MAX_TIMEOUT_MS})`,
        default: DEFAULT_TIMEOUT_MS,
      },
      cwd: {
        type: "string",
        description: "Working directory override, relative to the agent cwd (defaults to agent cwd)",
      },
      ...(sandbox?.allowUnsandboxed
        ? {
            dangerouslyDisableSandbox: {
              type: "boolean" as const,
              description:
                "Run this command outside the sandbox. Only for a command that failed inside it because the sandbox blocked something the task needs; the user's permission rules decide whether it may run.",
            },
          }
        : {}),
    },
    required: ["command"],
  };
}

function describe(shell: Shell, sandbox: Sandbox | undefined): string {
  const where =
    shell.kind === "cmd"
      ? sandbox?.backend.shell
        ? "Commands run in cmd.exe, the shell that can start in this sandbox: use cmd syntax such as dir, type, set and %VAR%."
        : "Commands run in cmd.exe (no bash was found on this Windows machine): use cmd syntax such as dir, type, set and %VAR%."
      : process.platform === "win32"
        ? "Commands run in Git Bash on Windows: use bash syntax; Windows programs are on the PATH as well."
        : `Commands run in ${shell.kind}.`;
  const limit = MAX_TOOL_OUTPUT_CHARS.toLocaleString("en-US");
  return [
    "Execute a shell command in the working directory. Returns stdout and stderr.",
    "Use for running scripts, installing packages, running tests, git operations, etc.",
    where,
    "Prefer short, composable commands. Avoid interactive commands: stdin is closed.",
    `Output longer than ${limit} characters is cut in the middle, and the whole of it saved to a file you can read.`,
    ...(sandbox ? [describeSandbox(sandbox)] : []),
  ].join(" ");
}

/** What the model is told about the sandbox: no paths, which change with the working directory and would break the prompt cache. */
function describeSandbox(sandbox: Sandbox): string {
  const domains = sandbox.allowedDomains;
  const network = domains.length > 0 ? `can reach only ${domains.join(", ")} on the network` : "have no network access";
  const way = sandbox.allowUnsandboxed
    ? "If a command fails because the sandbox blocked something it genuinely needs, call it again with dangerouslyDisableSandbox: true; it then runs outside the sandbox if the user's permission rules allow it, which usually means asking the user."
    : "Nothing runs outside the sandbox.";
  return [
    `Commands run in a sandbox (${sandbox.backend.name}): they can write only inside the working directory and the temp directory the sandbox gives them ($TMPDIR, or %TEMP% in cmd.exe),`,
    `cannot read credential stores such as ~/.ssh, and ${network}; variables named like keys or tokens are not passed in.`,
    ...(sandbox.backend.note ? [sandbox.backend.note] : []),
    "A blocked write or read fails with a permission error, a blocked connection with a network error.",
    way,
  ].join(" ");
}
