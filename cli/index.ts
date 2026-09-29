#!/usr/bin/env node
/**
 * agent-app CLI — an interactive REPL on top of the Agent framework.
 *
 * Usage:
 *   npm run cli                          # interactive REPL
 *   npm run cli -- -p "list *.ts here"   # one-shot, prints and exits
 *   npm run cli -- --read-only --model claude-sonnet-5
 *   npm run cli -- --resume <sessionId>
 *
 * Three things the REPL has to deal with, none of which show up when the
 * framework is driven from a one-shot script (see examples/):
 *
 *   1. stdin ownership. Permission prompts used to open their own readline
 *      interface on process.stdin, which would compete with the REPL's for
 *      keystrokes. PermissionSystem now takes an injectable PermissionPrompt,
 *      so both the REPL and the permission prompt read through the single
 *      LineReader below.
 *
 *   2. Handler accumulation. Agent.runWithOutput() calls this.on(...) on every
 *      invocation, so calling it N times in a loop registers N renderers and
 *      prints turn N's output N times. The REPL therefore uses run() and
 *      attaches its own renderer once per Agent instance.
 *
 *   3. No cross-turn memory. Agent.initSession() only resumes when
 *      resumeSessionId is set in the config, and config is private and never
 *      updated after a run — so calling run() twice on one instance produces
 *      two unrelated sessions. The REPL builds a fresh Agent per turn, seeded
 *      with the previous turn's sessionId. That is the resume path the
 *      framework already documents (examples/04-multi-turn.ts); a cleaner fix
 *      would be an Agent.continueSession() method, which is a change to the
 *      core API rather than to this entry point.
 */

import { readFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { serveAcp } from "../src/acp/index.js";
import * as readline from "node:readline";
import chalk from "chalk";
import { AGENT_TOOL_NAMES, Agent } from "../src/agent.js";
import { AllowlistJudge, createModelRouter, createRiskGate, LlmJudge } from "xavierjev";
import { PermissionPresets, parseDecision, parseRule } from "../src/permissions/index.js";
import { SessionManager } from "../src/session/manager.js";
import { globalRegistry, registerBuiltinTools } from "../src/tools/index.js";
import type {
  AgentConfig,
  AgentUsage,
  EffortLevel,
  ModelId,
  ModelRouter,
  PermissionContext,
  PermissionPrompt,
  PermissionRule,
  RiskGate,
} from "../src/types.js";
import type { HooksConfig } from "../src/hooks/index.js";
import { connectMcpServers, type McpConnection, type McpServerConfig } from "../src/mcp/index.js";
import { addCost } from "../src/utils/cost.js";
import { logger } from "../src/utils/logger.js";

registerBuiltinTools();

// ─────────────────────────────────────────────
// Line input
// ─────────────────────────────────────────────

/**
 * A single owner of stdin, shared by the REPL loop and by permission prompts.
 *
 * readline's own `question()` captures exactly one line per call, so any line
 * that arrives while no question is pending is dropped. That is invisible at a
 * TTY, where the user types one line at a time, but it silently eats input
 * when the CLI is driven from a pipe or a heredoc. Buffering every line in a
 * queue makes both cases behave the same, which is what lets the CLI be
 * scripted in tests and demos.
 */
class LineReader {
  private rl: readline.Interface;
  private queue: string[] = [];
  private waiters: ((line: string | null) => void)[] = [];
  private closed = false;
  private interruptHandler: (() => void) | undefined;

  constructor() {
    this.rl = readline.createInterface({ input: stdin, output: stdout });

    // At a TTY, Ctrl+C reaches readline rather than the process. With no
    // listener readline closes, and the REPL only noticed once the run in
    // progress had finished: Ctrl+C could not stop an agent mid-run.
    this.rl.on("SIGINT", () => (this.interruptHandler ? this.interruptHandler() : this.close()));

    this.rl.on("line", (line) => {
      const waiter = this.waiters.shift();
      if (waiter) {
        this.echo(line);
        waiter(line);
      } else {
        this.queue.push(line);
      }
    });

    this.rl.on("close", () => {
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) waiter(null);
    });
  }

  /** Called on Ctrl+C instead of closing. */
  onInterrupt(handler: () => void): void {
    this.interruptHandler = handler;
  }

  /**
   * Resolves to the next line, or null once stdin is exhausted — or once
   * `signal` aborts, so a permission question does not outlive its run and
   * swallow the next prompt the user types.
   */
  async question(prompt: string, signal?: AbortSignal): Promise<string | null> {
    stdout.write(prompt);

    const queued = this.queue.shift();
    if (queued !== undefined) {
      this.echo(queued);
      return queued;
    }
    if (this.closed || signal?.aborted) {
      stdout.write("\n");
      return null;
    }
    return new Promise((resolve) => {
      const onAbort = () => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        stdout.write("\n");
        resolve(null);
      };
      const waiter = (line: string | null) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(line);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /** A TTY echoes what the user types; a pipe does not, so do it by hand. */
  private echo(line: string): void {
    if (!stdin.isTTY) stdout.write(`${line}\n`);
  }

  close(): void {
    this.rl.close();
  }
}

// ─────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────

type PermissionPreset = "allow-all" | "ask" | "read-only";

type OutputFormat = "text" | "json" | "stream-json";
const OUTPUT_FORMATS: OutputFormat[] = ["text", "json", "stream-json"];

/** Which judge answers the risk question, or "off" to always ask. */
type GateBackend = "off" | "allowlist" | "llm";

const GATE_BACKENDS: GateBackend[] = ["off", "allowlist", "llm"];

function isGateBackend(value: string | undefined): value is GateBackend {
  return value !== undefined && (GATE_BACKENDS as string[]).includes(value);
}

interface CliOptions {
  model: ModelId;
  cwd: string;
  preset: PermissionPreset;
  /** From --allow and --deny, ahead of the preset's own rules. */
  rules: PermissionRule[];
  /** From --hooks: a Claude Code settings file, or just its "hooks" object. */
  hooks: HooksConfig | undefined;
  /** From --mcp-config: a Claude Code .mcp.json, or just its "mcpServers" object. */
  mcpServers: Record<string, McpServerConfig> | undefined;
  /** How -p reports: text for a person, json or stream-json for a program. */
  outputFormat: OutputFormat;
  /** Serve the Agent Client Protocol on stdio instead of the REPL. */
  acp: boolean;
  gate: GateBackend;
  /**
   * Auto-allow threshold for the gate. Undefined means the library default.
   *
   * Exposed as a flag because the right value turned out to be a property of
   * the judge, not of the gate. The default is 0.2, the highest value with
   * zero false allows for llama3.1:8b on both labelled sets; the same model
   * at 0.35 looked better on the dev set and then waved one command through
   * on the held-out one. Whoever changes the judge has to re-measure this.
   */
  gateThreshold: number | undefined;
  /** When set, route between this and `model` instead of always using `model`. */
  cheapModel: ModelId | undefined;
  /** Sent as output_config.effort when given; otherwise the model's own default applies. */
  effort: EffortLevel | undefined;
  /** Prompt tokens at which to compact; undefined is the model's default, false never. */
  compactAt: number | false | undefined;
  prompt: string | undefined;
  resume: string | undefined;
  maxTurns: number;
}

const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    model: (process.env.AGENT_MODEL as ModelId | undefined) ?? "claude-opus-5",
    cwd: process.cwd(),
    preset: "ask",
    rules: [],
    hooks: undefined,
    mcpServers: undefined,
    outputFormat: "text",
    acp: false,
    gate: "off",
    gateThreshold: undefined,
    cheapModel: undefined,
    effort: undefined,
    compactAt: undefined,
    prompt: undefined,
    resume: undefined,
    maxTurns: 20,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) {
        console.error(chalk.red(`Missing value for ${arg}`));
        process.exit(1);
      }
      return value;
    };

    switch (arg) {
      case "-p":
      case "--print":
        opts.prompt = next();
        break;
      case "-m":
      case "--model":
        opts.model = next() as ModelId;
        break;
      case "-C":
      case "--cwd":
        opts.cwd = next();
        break;
      case "--resume":
        opts.resume = next();
        break;
      case "--max-turns":
        opts.maxTurns = Number.parseInt(next(), 10);
        break;
      case "--allow-all":
        opts.preset = "allow-all";
        break;
      case "--ask":
        opts.preset = "ask";
        break;
      case "--read-only":
        opts.preset = "read-only";
        break;
      case "--hooks": {
        const file = next();
        try {
          const parsed = JSON.parse(readFileSync(file, "utf-8")) as { hooks?: HooksConfig } & HooksConfig;
          opts.hooks = parsed.hooks ?? parsed;
        } catch (err) {
          console.error(chalk.red(`--hooks ${file}: ${err instanceof Error ? err.message : String(err)}`));
          process.exit(1);
        }
        break;
      }
      case "--acp":
        opts.acp = true;
        break;
      case "--output-format": {
        const value = next();
        if (!(OUTPUT_FORMATS as string[]).includes(value)) {
          console.error(chalk.red(`--output-format must be one of ${OUTPUT_FORMATS.join(", ")}, got ${value}`));
          process.exit(1);
        }
        opts.outputFormat = value as OutputFormat;
        break;
      }
      case "--mcp-config": {
        const file = next();
        try {
          const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
            mcpServers?: Record<string, McpServerConfig>;
          } & Record<string, McpServerConfig>;
          opts.mcpServers = parsed.mcpServers ?? parsed;
        } catch (err) {
          console.error(chalk.red(`--mcp-config ${file}: ${err instanceof Error ? err.message : String(err)}`));
          process.exit(1);
        }
        break;
      }
      case "--allow":
      case "--deny": {
        const spec = next();
        try {
          opts.rules.push(parseRule(spec, arg === "--allow" ? "allow" : "deny"));
        } catch (err) {
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }
        break;
      }
      case "--gate": {
        // Optional value: bare --gate takes the judge backend. It used to
        // take the offline allow-list, on the strength of that list clearing
        // 24 of 35 safe commands with no false allows — but both halves of
        // that were properties of the set it was measured on. On commands
        // written afterwards it clears 5 of 55 and waves through 2 of 70,
        // where the model clears 18 of 55 with none. `--gate allowlist` is
        // still there for a machine with no judge endpoint.
        const value = argv[i + 1];
        if (isGateBackend(value)) {
          opts.gate = value;
          i++;
        } else {
          opts.gate = "llm";
        }
        break;
      }
      case "--gate-threshold": {
        const value = Number(next());
        if (!Number.isFinite(value) || value <= 0 || value >= 1) {
          console.error(chalk.red(`--gate-threshold must be in (0, 1), got ${value}`));
          process.exit(1);
        }
        opts.gateThreshold = value;
        break;
      }
      case "--cheap-model":
        opts.cheapModel = next() as ModelId;
        break;
      case "--effort": {
        const value = next();
        if (!(EFFORT_LEVELS as string[]).includes(value)) {
          console.error(chalk.red(`--effort must be one of ${EFFORT_LEVELS.join(", ")}, got ${value}`));
          process.exit(1);
        }
        opts.effort = value as EffortLevel;
        break;
      }
      case "--compact-at": {
        const value = next();
        const n = Number(value);
        if (value !== "off" && !(Number.isInteger(n) && n > 0)) {
          console.error(chalk.red(`--compact-at takes a token count or "off", got ${value}`));
          process.exit(1);
        }
        opts.compactAt = value === "off" ? false : n;
        break;
      }
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        console.error(chalk.red(`Unknown option: ${arg}`));
        printUsage();
        process.exit(1);
    }
  }

  if (opts.outputFormat !== "text" && opts.prompt === undefined) {
    console.error(chalk.red("--output-format json and stream-json need -p: the REPL is for a person"));
    process.exit(1);
  }
  return opts;
}

/**
 * Build the risk gate, or return undefined to keep asking about everything.
 *
 * Built once per REPL rather than per turn, so that a backend which has
 * already discovered its endpoint will not return logprobs does not
 * rediscover it — and re-warn about it — on every prompt.
 */
/**
 * Build the gate, and hand back the judge itself so the caller can probe it.
 *
 * The judge escapes the closure on purpose: `createRiskGate` only exposes a
 * verdict function, and knowing whether the endpoint will return logprobs is
 * a question about the backend, asked once at startup rather than per call.
 */
function resolveGate(
  backend: GateBackend,
  autoAllowBelow?: number,
): { gate: RiskGate | undefined; judge: LlmJudge | undefined } {
  const tuning = autoAllowBelow === undefined ? {} : { autoAllowBelow };
  switch (backend) {
    case "off":
      return { gate: undefined, judge: undefined };
    case "allowlist":
      return {
        gate: createRiskGate({ backend: new AllowlistJudge(), ...tuning }),
        judge: undefined,
      };
    case "llm": {
      const judge = new LlmJudge();
      return { gate: createRiskGate({ backend: judge, ...tuning }), judge };
    }
  }
}

function resolvePreset(preset: PermissionPreset): Partial<PermissionContext> {
  switch (preset) {
    case "allow-all":
      return PermissionPresets.allowAll();
    case "read-only":
      return PermissionPresets.readOnly();
    case "ask":
      return PermissionPresets.askDangerous();
  }
}

function printUsage(): void {
  console.log(`
${chalk.bold("agent-app")} — interactive CLI for the Agent framework

${chalk.bold("Usage")}
  npm run cli [-- options]

${chalk.bold("Options")}
  -p, --print <prompt>   Run one prompt, print the result, exit. Exit code 0 when
                         the model finished, 2 when the run stopped short (turn
                         limit, stuck, refusal, ...), 1 on an error, 130 if aborted
      --output-format <f> With -p: text (default), json (one result object) or
                         stream-json (one JSON event per line, then the result).
                         Asks are denied in json modes: nobody is there to answer
  -m, --model <id>       Model id (default: claude-opus-5)
  -C, --cwd <path>       Working directory for file and shell tools
      --resume <id>      Resume a saved session
      --max-turns <n>    Max agentic turns per prompt (default: 20)
      --allow-all        Never ask before running a tool
      --ask              Ask before Bash / Write / Edit (default)
      --read-only        Deny Bash / Write / Edit outright
      --allow <rule>     Allow what a rule covers without asking, e.g.
                         "Bash(npm test *)", "Edit(src/**)",
                         "WebFetch(domain:docs.python.org)"; repeatable
      --deny <rule>      Refuse what a rule covers, e.g. "Read(~/.ssh/**)";
                         a deny always wins; repeatable
      --hooks <file>     Lifecycle hooks, in Claude Code's settings format
                         (PreToolUse, PermissionRequest, PostToolUse, Stop, ...)
      --mcp-config <file>
                         MCP servers, in Claude Code's .mcp.json format; their
                         tools are mcp__<server>__<tool>, asked about under --ask
      --gate [backend]   Let a judge clear the easy "ask" cases
                         (allowlist = offline, default; llm = needs a key)
      --gate-threshold <n>
                         Auto-allow below this P(destructive). Model-specific
                         - measure with npm run eval:risk-gate before changing
      --cheap-model <id> Route each new session between this and --model, using the
                         same judge. Needs --gate to supply one.
      --effort <level>   low | medium | high | xhigh | max, sent as
                         output_config.effort (default: the model's own)
      --compact-at <n>   Compact the conversation once a prompt reaches n
                         tokens, or "off" (default: 80% of the model's
                         context window, at most 150,000)
      --acp              Serve the Agent Client Protocol on stdio, for an editor
                         (Zed, JetBrains, ...) or a harness to drive
  -h, --help             Show this help

${chalk.bold("Slash commands (REPL)")}
  /help                  Show this help
  /tools                 List registered tools
  /cost                  Show token and cost totals for this REPL
  /sessions              List recent saved sessions
  /resume <id>           Continue a saved session
  /new                   Start a fresh session
  /model [id]            Show or change the model
  /permissions <preset>  allow-all | ask | read-only
  /gate [backend]        off | allowlist | llm
  /cwd [path]            Show or change the working directory
  /exit                  Quit
`);
}

// ─────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────

/**
 * Attach the streaming renderer to a freshly built Agent.
 * Called exactly once per Agent instance — see note 2 in the file header.
 */
function attachRenderer(agent: Agent): void {
  // Thinking and answer text arrive as separate streams that can alternate
  // several times in one turn. Without a break on every transition they run
  // together into one paragraph — visible with any provider that narrates its
  // plan before calling a tool.
  let stream: "text" | "thinking" | null = null;

  const startStream = (kind: "text" | "thinking") => {
    if (stream !== null && stream !== kind) stdout.write("\n");
    stream = kind;
  };

  const endStream = () => {
    if (stream !== null) {
      stdout.write("\n");
      stream = null;
    }
  };

  agent.on((event) => {
    switch (event.type) {
      case "text_delta":
        startStream("text");
        stdout.write(event.delta);
        break;
      case "thinking_delta":
        startStream("thinking");
        stdout.write(chalk.magenta(event.delta));
        break;
      case "tool_start":
        endStream();
        console.log(
          chalk.cyan(`⚙  ${event.toolName}`) +
            chalk.gray(` — ${JSON.stringify(event.input).slice(0, 100)}`),
        );
        break;
      case "tool_end": {
        const status = event.result.type === "success" ? chalk.green("ok") : chalk.red("error");
        console.log(chalk.gray(`   ${status} in ${event.durationMs}ms`));
        break;
      }
      case "todos":
        endStream();
        for (const t of event.todos) {
          const mark = t.status === "completed" ? "✔" : t.status === "in_progress" ? "▶" : "·";
          console.log(chalk.gray(`   ${mark} ${t.content}`));
        }
        break;
      case "subagent":
        if (event.event.type === "tool_start") {
          endStream();
          console.log(
            chalk.gray(`   ↳ ${event.subagent} ⚙ ${event.event.toolName} — ${JSON.stringify(event.event.input).slice(0, 90)}`),
          );
        }
        break;
      case "compacted": {
        endStream();
        const where = event.transcript ? ` — full transcript: ${event.transcript}` : "";
        console.log(
          chalk.gray(`⟲  Compacted the conversation at ${event.promptTokens.toLocaleString("en-US")} prompt tokens${where}`),
        );
        break;
      }
      default:
        break;
    }
  });
}

function formatUsage(usage: AgentUsage): string {
  const total = usage.inputTokens + usage.outputTokens;
  return chalk.gray(
    `[${total} tokens · in ${usage.inputTokens} / out ${usage.outputTokens}` +
      ` · cache ${usage.cacheReadTokens} read` +
      ` · ${usd(usage.estimatedCostUsd)}]`,
  );
}

/** Null is a model with no price in src/utils/cost.ts. */
function usd(cost: number | null): string {
  return cost === null ? "cost unknown" : `$${cost.toFixed(5)}`;
}

/**
 * A permission prompt that reads through the REPL's LineReader instead of
 * opening a second reader on stdin — see note 1 in the file header.
 */
function replPrompt(reader: LineReader, runSignal: () => AbortSignal | undefined): PermissionPrompt {
  return async (request) => {
    console.log(
      chalk.yellow("\n⚠  Permission required") +
        chalk.white(` for ${chalk.bold(request.toolName)}`),
    );
    if (request.description) {
      console.log(chalk.gray(`   ${request.description}`));
    }
    const answer = await reader.question(
      chalk.yellow("   Allow? [y/N/a (always)/d (deny always)]: "),
      runSignal(),
    );
    return parseDecision(answer ?? "");
  };
}

// ─────────────────────────────────────────────
// REPL state
// ─────────────────────────────────────────────

class ReplState {
  model: ModelId;
  cwd: string;
  preset: PermissionPreset;
  rules: PermissionRule[];
  hooks: HooksConfig | undefined;
  gateBackend: GateBackend;
  gateThreshold: number | undefined;
  maxTurns: number;
  effort: EffortLevel | undefined;
  compactAt: number | false | undefined;
  sessionId: string | undefined;
  /** The run in progress, so Ctrl+C can stop it. */
  current: AbortController | undefined;
  /** Left undefined in one-shot mode, where the default stdin prompt is fine. */
  prompt: PermissionPrompt | undefined;
  /** Undefined when the gate is off; rebuilt only when the backend changes. */
  private gate: RiskGate | undefined;
  /** Undefined unless --cheap-model asked for routing. */
  private router: ModelRouter | undefined;
  /** The judge behind the gate, kept only so verifyGate() can probe it. */
  private judge: LlmJudge | undefined;

  turns = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  totalCostUsd: number | null = 0;

  constructor(opts: CliOptions) {
    this.model = opts.model;
    this.cwd = opts.cwd;
    this.preset = opts.preset;
    this.rules = opts.rules;
    this.hooks = opts.hooks;
    this.gateBackend = opts.gate;
    this.gateThreshold = opts.gateThreshold;
    this.maxTurns = opts.maxTurns;
    this.effort = opts.effort;
    this.compactAt = opts.compactAt;
    this.sessionId = opts.resume;
    this.current = undefined;
    this.prompt = undefined;
    const resolved = resolveGate(opts.gate, opts.gateThreshold);
    this.gate = resolved.gate;
    this.judge = resolved.judge;

    // Routing shares the gate's judge rather than opening a second one: the
    // two questions are different, the backend answering them is not.
    if (opts.cheapModel && resolved.judge) {
      this.router = createModelRouter({
        backend: resolved.judge,
        strong: opts.model,
        cheap: opts.cheapModel,
      });
    } else if (opts.cheapModel) {
      console.log(chalk.yellow("⚠  --cheap-model needs a judge; pass --gate llm to supply one."));
    }
  }

  /** Swap the judge, reporting failure rather than silently running without one. */
  setGateBackend(backend: GateBackend): boolean {
    try {
      const resolved = resolveGate(backend, this.gateThreshold);
      this.gate = resolved.gate;
      this.judge = resolved.judge;
      this.gateBackend = backend;
      return true;
    } catch (err) {
      console.log(chalk.red(err instanceof Error ? err.message : String(err)));
      return false;
    }
  }

  /**
   * Check the judge can do the job before the session starts relying on it.
   *
   * Worth a round trip now that `llm` is the default. Without it, an endpoint
   * that ignores `logprobs` produces a gate that defers every single call —
   * which looks exactly like a gate nobody turned on, and the only hint is a
   * warning line per tool call. Failing here is not fatal: the gate comes off
   * and every call goes to the user, which is the behaviour `--ask` had all
   * along.
   */
  async verifyGate(): Promise<void> {
    if (this.gateBackend !== "llm" || !this.judge) return;

    const capability = await this.judge.probe();
    if (capability.logprobs) return;

    console.log(chalk.yellow(`⚠  Risk gate disabled — ${this.judge.name} ${capability.detail}.`));
    console.log(
      chalk.gray(
        "   A judge with no token probabilities has nothing to threshold, so every\n" +
          "   call would fall through to you anyway. Use --gate allowlist for an\n" +
          "   offline judge, or point AGENT_JUDGE_BASE_URL at an endpoint that\n" +
          "   returns logprobs (a local Ollama does).",
      ),
    );
    this.gate = undefined;
    this.judge = undefined;
    this.gateBackend = "off";
  }

  /**
   * Build an Agent for the next turn, seeded with the current session so the
   * conversation carries over — see note 3 in the file header.
   */
  /** What every Agent this CLI makes shares; buildAgent and the ACP server both start from it. */
  agentConfig(): AgentConfig {
    return {
      model: this.model,
      cwd: this.cwd,
      maxTurns: this.maxTurns,
      ...(this.effort ? { effort: this.effort } : {}),
      ...(this.compactAt !== undefined ? { compactAt: this.compactAt } : {}),
      ...(this.hooks ? { hooks: this.hooks } : {}),
      permissions: {
        ...resolvePreset(this.preset),
        rules: [...this.rules, ...(resolvePreset(this.preset).rules ?? [])],
        ...(this.gate ? { gate: this.gate } : {}),
      },
      ...(this.router ? { router: this.router } : {}),
      persistSessions: true,
    };
  }

  buildAgent(render = true): Agent {
    const agent = new Agent({
      model: this.model,
      cwd: this.cwd,
      maxTurns: this.maxTurns,
      ...(this.effort ? { effort: this.effort } : {}),
      ...(this.compactAt !== undefined ? { compactAt: this.compactAt } : {}),
      ...(this.hooks ? { hooks: this.hooks } : {}),
      permissions: {
        ...resolvePreset(this.preset),
        rules: [...this.rules, ...(resolvePreset(this.preset).rules ?? [])],
        ...(this.prompt ? { prompt: this.prompt } : {}),
        ...(this.gate ? { gate: this.gate } : {}),
      },
      ...(this.router ? { router: this.router } : {}),
      persistSessions: true,
      stream: true,
      ...(this.sessionId ? { resumeSessionId: this.sessionId } : {}),
    });
    if (render) attachRenderer(agent);
    // Known as soon as the run starts: a run that throws has still saved its
    // session, and the next prompt should continue that one.
    agent.on((event) => {
      if (event.type === "session") this.sessionId = event.sessionId;
    });
    return agent;
  }

  record(usage: AgentUsage, sessionId: string): void {
    this.turns++;
    this.totalInputTokens += usage.inputTokens;
    this.totalOutputTokens += usage.outputTokens;
    this.totalCostUsd = addCost(this.totalCostUsd, usage.estimatedCostUsd);
    this.sessionId = sessionId;
  }
}

// ─────────────────────────────────────────────
// Slash commands
// ─────────────────────────────────────────────

const sessionManager = new SessionManager();

class ExitRepl extends Error {}

/** Returns true if the input was handled as a command (so don't send it to the agent). */
async function handleCommand(input: string, state: ReplState): Promise<boolean> {
  if (!input.startsWith("/")) return false;

  const [command = "", ...rest] = input.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (command) {
    case "help":
      printUsage();
      return true;

    case "exit":
    case "quit":
      throw new ExitRepl();

    case "tools":
      console.log(chalk.bold("Registered tools:"));
      for (const name of [...globalRegistry.names(), ...AGENT_TOOL_NAMES]) {
        console.log(`  ${chalk.cyan(name)}`);
      }
      return true;

    case "cost":
      console.log(
        chalk.bold(`${state.turns} prompt(s) this session — `) +
          formatUsage({
            inputTokens: state.totalInputTokens,
            outputTokens: state.totalOutputTokens,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            estimatedCostUsd: state.totalCostUsd,
          }),
      );
      return true;

    case "sessions": {
      const list = await sessionManager.list();
      if (list.length === 0) {
        console.log(chalk.gray("No saved sessions."));
        return true;
      }
      console.log(chalk.bold(`${list.length} saved session(s), most recent first:`));
      for (const s of list.slice(0, 10)) {
        console.log(
          chalk.gray(`  ${s.updatedAt.slice(0, 19)}  `) +
            chalk.cyan(s.sessionId.slice(0, 8)) +
            chalk.gray(`  ${s.turns} turns  ${usd(s.totalCost)}`) +
            (s.interrupted ? chalk.yellow("  (ended early)") : ""),
        );
      }
      return true;
    }

    case "resume": {
      if (!arg) {
        console.log(chalk.yellow("Usage: /resume <sessionId>"));
        return true;
      }
      const session = await sessionManager.load(arg);
      if (!session) {
        console.log(chalk.red(`Session not found: ${arg}`));
        return true;
      }
      state.sessionId = arg;
      console.log(
        chalk.green(
          `Resumed ${arg.slice(0, 8)} — ${session.messages.length} message(s) in context.`,
        ),
      );
      return true;
    }

    case "new":
    case "clear":
      state.sessionId = undefined;
      console.log(chalk.green("Started a new session."));
      return true;

    case "model":
      if (arg) {
        state.model = arg as ModelId;
        console.log(chalk.green(`Model set to ${arg}.`));
      } else {
        console.log(`Model: ${chalk.cyan(state.model)}`);
      }
      return true;

    case "permissions":
      if (arg === "allow-all" || arg === "ask" || arg === "read-only") {
        state.preset = arg;
        console.log(chalk.green(`Permissions set to ${arg}.`));
      } else {
        console.log(
          `Permissions: ${chalk.cyan(state.preset)} ${chalk.gray("(allow-all | ask | read-only)")}`,
        );
      }
      return true;

    case "gate":
      if (isGateBackend(arg)) {
        if (state.setGateBackend(arg)) {
          console.log(chalk.green(`Risk gate set to ${arg}.`));
        }
      } else {
        console.log(
          `Risk gate: ${chalk.cyan(state.gateBackend)} ${chalk.gray("(off | allowlist | llm)")}`,
        );
      }
      return true;

    case "cwd":
      if (arg) {
        state.cwd = arg;
        console.log(chalk.green(`Working directory set to ${arg}.`));
      } else {
        console.log(`Working directory: ${chalk.cyan(state.cwd)}`);
      }
      return true;

    default:
      console.log(chalk.yellow(`Unknown command: /${command} — try /help`));
      return true;
  }
}

// ─────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────

function requireApiKey(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      chalk.red("ANTHROPIC_API_KEY is not set.") +
        chalk.gray("\n  Copy .env.example to .env and fill it in, or export the variable."),
    );
    process.exit(1);
  }
}

/** Stop reasons whose text was never streamed, so the user would not otherwise see why the run ended. */
const EXPLAINED_STOPS = new Set(["stuck", "max_tokens", "refusal", "model_context_window_exceeded"]);

/** 0 finished, 2 stopped short of finishing, 130 stopped by the user; 1 is left for a run that threw. */
function exitCodeFor(stopReason: string): number {
  if (stopReason === "end_turn") return 0;
  return stopReason === "aborted" ? 130 : 2;
}

async function runOnce(state: ReplState, prompt: string): Promise<string> {
  const agent = state.buildAgent();
  const controller = new AbortController();
  state.current = controller;
  try {
    const result = await agent.run(prompt, { signal: controller.signal });
    state.record(result.usage, result.sessionId);
    stdout.write("\n");
    if (result.stopReason === "aborted") {
      console.log(chalk.yellow("⏹  Stopped. The session is saved; the next prompt continues it."));
    } else if (result.stopReason === "max_turns") {
      console.log(chalk.yellow(`⏹  Stopped at the turn limit (${state.maxTurns}).`));
    } else if (EXPLAINED_STOPS.has(result.stopReason) && result.text) {
      console.log(chalk.yellow(`⏹  ${result.text}`));
    }
    console.log(formatUsage(result.usage));
    return result.stopReason;
  } finally {
    state.current = undefined;
  }
}

/**
 * One prompt for a program: stdout carries JSON and nothing else — for
 * stream-json each event as a line (not the token deltas), then for both
 * formats one result object — and everything meant for a person goes to
 * stderr. Returns the exit code.
 */
async function runHeadless(state: ReplState, prompt: string, format: "json" | "stream-json"): Promise<number> {
  const agent = state.buildAgent(false);
  const controller = new AbortController();
  state.current = controller;
  const started = Date.now();
  const line = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`);
  if (format === "stream-json") {
    agent.on((event) => {
      if (event.type !== "text_delta" && event.type !== "thinking_delta" && event.type !== "done") line(event);
    });
  }
  try {
    const result = await agent.run(prompt, { signal: controller.signal });
    const code = exitCodeFor(result.stopReason);
    line({
      type: "result",
      subtype: code === 0 ? "success" : `stopped_${result.stopReason}`,
      is_error: code !== 0,
      stop_reason: result.stopReason,
      result: result.text,
      session_id: result.sessionId,
      num_turns: result.turns,
      tool_calls: result.toolCalls.length,
      duration_ms: Date.now() - started,
      usage: {
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        cache_creation_input_tokens: result.usage.cacheCreationTokens,
        cache_read_input_tokens: result.usage.cacheReadTokens,
      },
      total_cost_usd: result.usage.estimatedCostUsd,
    });
    return code;
  } catch (err) {
    line({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      error: err instanceof Error ? err.message : String(err),
      session_id: state.sessionId ?? null,
      duration_ms: Date.now() - started,
    });
    return 1;
  } finally {
    state.current = undefined;
  }
}

/** In a headless run a call that needs asking is denied, and stderr says so. */
const headlessPrompt: PermissionPrompt = async (request) => {
  console.error(
    chalk.yellow(`⚠  ${request.toolName} needs permission and a headless run cannot ask: denied — ${request.description}`),
  );
  console.error(chalk.gray('   Allow it with --allow "<rule>" or --allow-all.'));
  return "deny";
};

let exitCode = 0;

/**
 * Ctrl+C: the first stops the run in progress (calls already running finish,
 * and the session is saved), a second quits. With no run, it quits.
 */
function interrupt(state: ReplState, reader?: LineReader): void {
  const run = state.current;
  if (run && !run.signal.aborted) {
    run.abort();
    console.log(chalk.yellow("\n⏹  Stopping — calls already running will finish. Ctrl+C again to quit now."));
    return;
  }
  if (run || !reader) process.exit(130);
  reader.close();
}

async function repl(state: ReplState): Promise<void> {
  const reader = new LineReader();
  state.prompt = replPrompt(reader, () => state.current?.signal);
  reader.onInterrupt(() => interrupt(state, reader));
  // Under a pipe Ctrl+C is a real SIGINT, which readline never sees.
  process.on("SIGINT", () => interrupt(state, reader));

  console.log(
    chalk.bold("agent-app") +
      chalk.gray(
        ` · ${state.model} · ${state.preset}${state.gateBackend === "off" ? "" : `+gate:${state.gateBackend}`} · ${state.cwd}`,
      ),
  );
  console.log(chalk.gray("Type a prompt, or /help for commands. Ctrl+C to quit.\n"));

  try {
    for (;;) {
      const line = await reader.question(chalk.green("› "));
      if (line === null) return; // Ctrl+C, or end of piped input

      const input = line.trim();
      if (!input) continue;

      try {
        if (await handleCommand(input, state)) continue;
      } catch (err) {
        if (err instanceof ExitRepl) return;
        throw err;
      }

      try {
        await runOnce(state, input);
      } catch (err) {
        console.error(chalk.red(`\nError: ${err instanceof Error ? err.message : String(err)}`));
      }

      stdout.write("\n");
    }
  } finally {
    reader.close();
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  requireApiKey();
  const headless = opts.outputFormat !== "text" || opts.acp;
  if (headless) {
    // stdout is the JSON; anything else the CLI or the loop says goes to stderr.
    console.log = (...args: unknown[]) => console.error(...args);
    if (!process.env.AGENT_LOG_LEVEL) logger.setLevel("warn");
  }

  const state = new ReplState(opts);
  if (headless) state.prompt = headlessPrompt;
  await state.verifyGate();
  const mcp = opts.mcpServers ? await startMcp(opts.mcpServers) : undefined;

  if (opts.acp) {
    // stdout is the protocol. Serve until the editor closes the connection.
    const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>);
    const { cwd: _cwd, ...agent } = state.agentConfig();
    const conn = serveAcp(stream, { agent });
    await conn.closed;
    await mcp?.close();
    return;
  }

  try {
    if (opts.prompt !== undefined) {
      process.on("SIGINT", () => interrupt(state));
      exitCode =
        opts.outputFormat === "text"
          ? exitCodeFor(await runOnce(state, opts.prompt))
          : await runHeadless(state, opts.prompt, opts.outputFormat);
      return;
    }
    await repl(state);
  } finally {
    await mcp?.close();
  }
}

/** Connect the configured MCP servers and register their tools; a server that fails is reported, not fatal. */
async function startMcp(servers: Record<string, McpServerConfig>): Promise<McpConnection> {
  const mcp = await connectMcpServers(servers);
  globalRegistry.register(...mcp.tools);
  const connected = Object.keys(servers).filter((name) => !mcp.failures.some((f) => f.server === name));
  if (connected.length > 0) {
    console.log(chalk.gray(`MCP: ${mcp.tools.length} tool(s) from ${connected.join(", ")}`));
  }
  for (const f of mcp.failures) console.log(chalk.yellow(`⚠  MCP server ${f.server} unavailable: ${f.error}`));
  return mcp;
}

// exitCode, not process.exit(): exiting while the model API's keep-alive
// socket is still closing trips a libuv assertion on Windows, and the process
// ends with 0xC0000409 whatever the run's own outcome was.
main().then(
  () => {
    process.exitCode = exitCode;
  },
  (err: unknown) => {
    console.error(chalk.red(err instanceof Error ? (err.stack ?? err.message) : String(err)));
    process.exitCode = 1;
  },
);
