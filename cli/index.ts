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

import { stdin, stdout } from "node:process";
import * as readline from "node:readline";
import chalk from "chalk";
import { Agent } from "../src/agent.js";
import { PermissionPresets, parseDecision } from "../src/permissions/index.js";
import { SessionManager } from "../src/session/manager.js";
import { globalRegistry, registerBuiltinTools } from "../src/tools/index.js";
import type { AgentUsage, ModelId, PermissionContext, PermissionPrompt } from "../src/types.js";

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

  constructor() {
    this.rl = readline.createInterface({ input: stdin, output: stdout });

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

  /** Resolves to the next line, or null once stdin is exhausted. */
  async question(prompt: string): Promise<string | null> {
    stdout.write(prompt);

    const queued = this.queue.shift();
    if (queued !== undefined) {
      this.echo(queued);
      return queued;
    }
    if (this.closed) {
      stdout.write("\n");
      return null;
    }
    return new Promise((resolve) => this.waiters.push(resolve));
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

interface CliOptions {
  model: ModelId;
  cwd: string;
  preset: PermissionPreset;
  prompt: string | undefined;
  resume: string | undefined;
  maxTurns: number;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    model: (process.env.AGENT_MODEL as ModelId | undefined) ?? "claude-opus-5",
    cwd: process.cwd(),
    preset: "ask",
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

  return opts;
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
  -p, --print <prompt>   Run one prompt, print the result, exit
  -m, --model <id>       Model id (default: claude-opus-5)
  -C, --cwd <path>       Working directory for file and shell tools
      --resume <id>      Resume a saved session
      --max-turns <n>    Max agentic turns per prompt (default: 20)
      --allow-all        Never ask before running a tool
      --ask              Ask before Bash / Write / Edit (default)
      --read-only        Deny Bash / Write / Edit outright
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
  let wroteText = false;

  agent.on((event) => {
    switch (event.type) {
      case "text_delta":
        stdout.write(event.delta);
        wroteText = true;
        break;
      case "thinking_delta":
        stdout.write(chalk.magenta(event.delta));
        break;
      case "tool_start":
        if (wroteText) {
          stdout.write("\n");
          wroteText = false;
        }
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
      ` · $${usage.estimatedCostUsd.toFixed(5)}]`,
  );
}

/**
 * A permission prompt that reads through the REPL's LineReader instead of
 * opening a second reader on stdin — see note 1 in the file header.
 */
function replPrompt(reader: LineReader): PermissionPrompt {
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
  maxTurns: number;
  sessionId: string | undefined;
  /** Left undefined in one-shot mode, where the default stdin prompt is fine. */
  prompt: PermissionPrompt | undefined;

  turns = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  totalCostUsd = 0;

  constructor(opts: CliOptions) {
    this.model = opts.model;
    this.cwd = opts.cwd;
    this.preset = opts.preset;
    this.maxTurns = opts.maxTurns;
    this.sessionId = opts.resume;
    this.prompt = undefined;
  }

  /**
   * Build an Agent for the next turn, seeded with the current session so the
   * conversation carries over — see note 3 in the file header.
   */
  buildAgent(): Agent {
    const agent = new Agent({
      model: this.model,
      cwd: this.cwd,
      maxTurns: this.maxTurns,
      permissions: {
        ...resolvePreset(this.preset),
        ...(this.prompt ? { prompt: this.prompt } : {}),
      },
      persistSessions: true,
      stream: true,
      ...(this.sessionId ? { resumeSessionId: this.sessionId } : {}),
    });
    attachRenderer(agent);
    return agent;
  }

  record(usage: AgentUsage, sessionId: string): void {
    this.turns++;
    this.totalInputTokens += usage.inputTokens;
    this.totalOutputTokens += usage.outputTokens;
    this.totalCostUsd += usage.estimatedCostUsd;
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
      for (const name of globalRegistry.names()) {
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
            chalk.gray(`  ${s.turns} turns  $${s.totalCost.toFixed(5)}`),
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

async function runOnce(state: ReplState, prompt: string): Promise<void> {
  const agent = state.buildAgent();
  const result = await agent.run(prompt);
  state.record(result.usage, result.sessionId);
  stdout.write("\n");
  console.log(formatUsage(result.usage));
}

async function repl(state: ReplState): Promise<void> {
  const reader = new LineReader();
  state.prompt = replPrompt(reader);

  console.log(
    chalk.bold("agent-app") + chalk.gray(` · ${state.model} · ${state.preset} · ${state.cwd}`),
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

  const state = new ReplState(opts);

  if (opts.prompt !== undefined) {
    await runOnce(state, opts.prompt);
    return;
  }

  await repl(state);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(chalk.red(err instanceof Error ? (err.stack ?? err.message) : String(err)));
    process.exit(1);
  },
);
