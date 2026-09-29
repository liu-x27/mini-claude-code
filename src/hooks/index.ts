import { spawn } from "node:child_process";
import { resolveShell } from "../tools/shell.js";
import { logger } from "../utils/logger.js";

/**
 * Lifecycle hooks in Claude Code's format, so its hook scripts and settings
 * work here unchanged: the same event names, the same JSON on stdin, exit
 * code 2 to block, and the same JSON answers on stdout. The events are the
 * subset this loop has a place for.
 */
export type HookEvent = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PermissionRequest" | "PostToolUse" | "Stop";

export type HookHandler =
  /** A shell command, run in the Bash tool's shell, with the input as JSON on stdin. */
  | { type: "command"; command: string; timeout?: number }
  /** A POST of the input as JSON; the response body is the answer. */
  | { type: "http"; url: string; timeout?: number; headers?: Record<string, string> }
  /** In-process, for the library. */
  | { type: "function"; run: (input: HookInput) => Promise<HookOutput | undefined> | HookOutput | undefined };

export interface HookMatcher {
  /** A regular expression over the tool name, for the tool events; empty or "*" is every tool. */
  matcher?: string;
  hooks: HookHandler[];
}

export type HooksConfig = Partial<Record<HookEvent, HookMatcher[]>>;

export interface HookInput {
  hook_event_name: HookEvent;
  session_id: string;
  cwd: string;
  permission_mode: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  tool_response?: unknown;
  prompt?: string;
  source?: "startup";
  stop_hook_active?: boolean;
}

/** The fields of Claude Code's hook output this loop honours. */
export interface HookOutput {
  continue?: boolean;
  stopReason?: string;
  decision?: "block" | "approve";
  reason?: string;
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
    decision?: { behavior: "allow" | "deny"; message?: string; updatedInput?: Record<string, unknown> };
  };
}

/** What the hooks for one event came to, in the order they ran. */
export interface HookOutcome {
  /** Why the action is blocked or denied: exit code 2's stderr, or a block or deny answer. */
  block?: string;
  allow?: boolean;
  ask?: boolean;
  updatedInput?: Record<string, unknown>;
  /** additionalContext, and for SessionStart and UserPromptSubmit plain stdout, for the model. */
  context: string[];
  /** `continue: false`: end the run, with this as the reason. */
  stop?: string;
}

const DEFAULT_TIMEOUT_S = 60;

/**
 * Run every hook for `event` whose matcher fits `toolName`, one after
 * another. The first block ends the list; an input one hook rewrites is what
 * the next one sees. A hook that fails any other way — a crash, a timeout, a
 * non-zero exit other than 2, an answer that is not JSON — is logged and
 * does not block: Claude Code's rule, and the only one under which a broken
 * hook cannot wedge every tool call.
 */
export async function runHooks(
  config: HooksConfig | undefined,
  event: HookEvent,
  input: HookInput,
  toolName?: string,
): Promise<HookOutcome> {
  const outcome: HookOutcome = { context: [] };
  const matchers = config?.[event] ?? [];
  let current = input;

  for (const m of matchers) {
    if (!matcherFits(m.matcher, toolName)) continue;
    for (const handler of m.hooks) {
      const answer = await runHandler(handler, current);
      if (answer.error) {
        logger.warn(`${event} hook failed, ignored: ${answer.error}`);
        continue;
      }
      if (answer.blocked !== undefined) {
        outcome.block = answer.blocked || `blocked by a ${event} hook`;
        return outcome;
      }
      const out = answer.output;
      if (answer.text && (event === "SessionStart" || event === "UserPromptSubmit")) outcome.context.push(answer.text);
      if (!out) continue;

      const specific = out.hookSpecificOutput;
      if (specific?.additionalContext) outcome.context.push(specific.additionalContext);
      if (out.continue === false) outcome.stop = out.stopReason ?? `stopped by a ${event} hook`;

      const permission = specific?.permissionDecision ?? specific?.decision?.behavior;
      const denied = out.decision === "block" || permission === "deny";
      if (denied) {
        outcome.block =
          specific?.permissionDecisionReason ?? specific?.decision?.message ?? out.reason ?? `blocked by a ${event} hook`;
        return outcome;
      }
      if (permission === "allow" || out.decision === "approve") outcome.allow = true;
      if (permission === "ask") outcome.ask = true;
      const updated = specific?.updatedInput ?? specific?.decision?.updatedInput;
      if (updated && typeof updated === "object") {
        outcome.updatedInput = updated;
        current = { ...current, tool_input: updated };
      }
      if (outcome.stop) return outcome;
    }
  }
  return outcome;
}

function matcherFits(matcher: string | undefined, toolName: string | undefined): boolean {
  if (!matcher || matcher === "*" || toolName === undefined) return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName);
  } catch {
    return matcher === toolName;
  }
}

interface HandlerAnswer {
  output?: HookOutput;
  /** Set on exit code 2: the reason, from stderr. */
  blocked?: string;
  /** Plain (non-JSON) stdout. */
  text?: string;
  error?: string;
}

async function runHandler(handler: HookHandler, input: HookInput): Promise<HandlerAnswer> {
  const timeoutMs = (("timeout" in handler && handler.timeout) || DEFAULT_TIMEOUT_S) * 1000;
  try {
    switch (handler.type) {
      case "function": {
        const output = await handler.run(input);
        return output ? { output } : {};
      }
      case "http": {
        const res = await fetch(handler.url, {
          method: "POST",
          headers: { "content-type": "application/json", ...handler.headers },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return { error: `${handler.url} answered HTTP ${res.status}` };
        const body = (await res.text()).trim();
        return body ? { output: JSON.parse(body) as HookOutput } : {};
      }
      case "command":
        return await runCommandHook(handler.command, input, timeoutMs);
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function runCommandHook(command: string, input: HookInput, timeoutMs: number): Promise<HandlerAnswer> {
  const shell = resolveShell();
  return new Promise((resolve) => {
    const child = spawn(shell.file, shell.args(command), {
      cwd: input.cwd,
      env: { ...process.env, AGENT_PROJECT_DIR: input.cwd, CLAUDE_PROJECT_DIR: input.cwd },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: shell.verbatim,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf-8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf-8");
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ error: `"${command}" timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 2) return resolve({ blocked: stderr.trim() });
      if (code !== 0) return resolve({ error: `"${command}" exited ${code}: ${stderr.trim().slice(0, 200)}` });
      const text = stdout.trim();
      if (!text.startsWith("{")) return resolve(text ? { text } : {});
      try {
        resolve({ output: JSON.parse(text) as HookOutput });
      } catch {
        resolve({ error: `"${command}" printed something that is not JSON` });
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(input));
  });
}
