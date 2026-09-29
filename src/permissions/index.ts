import * as readline from "node:readline/promises";
import chalk from "chalk";
import type {
  PermissionContext,
  PermissionDecision,
  PermissionMode,
  PermissionPrompt,
  PermissionRequest,
  RiskGate,
} from "../types.js";
import { logger } from "../utils/logger.js";
import { ruleMatches, specificity } from "./rules.js";

export { parseRule } from "./rules.js";

/**
 * Evaluates whether a tool call is permitted, based on configured rules.
 * In "ask" mode, prompts the user interactively via stdin.
 */
export class PermissionSystem {
  private context: PermissionContext;
  private prompt: PermissionPrompt;
  private gate: RiskGate | undefined;
  private onAsk: PermissionContext["onAsk"];
  private gateTools: Set<string>;
  /** Tail of the queue of questions to the user — see promptUser(). */
  private promptQueue: Promise<unknown> = Promise.resolve();

  constructor(context?: Partial<PermissionContext>) {
    // `prompt` and `gate` are kept off `this.context` so that getContext() —
    // which is handed to every tool as ToolContext.permissions — stays plain
    // data.
    this.context = {
      defaultMode: context?.defaultMode ?? "allow",
      rules: context?.rules ?? [],
    };
    this.prompt = context?.prompt ?? stdinPrompt;
    this.gate = context?.gate;
    this.onAsk = context?.onAsk;
    this.gateTools = new Set(context?.gateTools ?? ["Bash"]);
  }

  /**
   * Check if a tool call should be allowed.
   * Returns true if allowed, false if denied.
   * In "ask" mode, interactively prompts the user.
   */
  async check(request: PermissionRequest, options: { hook?: "allow" | "ask" } = {}): Promise<boolean> {
    const mode = this.resolveMode(request);

    // A PreToolUse hook may allow a call or insist it is asked about, but it
    // cannot reopen a call a rule denies.
    if (mode !== "deny" && options.hook === "allow") return true;
    if (mode !== "deny" && options.hook === "ask") return this.promptUser(request);

    switch (mode) {
      case "allow":
        return true;

      case "deny":
        logger.warn(`Permission denied for tool: ${request.toolName}`);
        return false;

      case "ask":
        return this.askOrGate(request);
    }
  }

  /**
   * The "ask" path, with an optional gate in front of the user.
   *
   * The gate is deliberately downstream of `resolveMode`: a call the rules
   * already allowed never pays for a judge, and a call the rules denied is
   * not something a judge gets to reopen.
   */
  private async askOrGate(request: PermissionRequest): Promise<boolean> {
    if (this.onAsk) {
      const answer = await this.onAsk(request);
      if (answer === "allow") return true;
      if (answer === "deny") return false;
    }

    // Only where it was measured. Write, Edit and WebFetch used to reach it
    // too, and a threshold chosen on shell commands was clearing file writes
    // and fetches no number stands behind; XavierJev's own Claude Code
    // integration refuses anything but Bash for the same reason.
    if (this.gate && this.gateTools.has(request.toolName)) {
      const verdict = await this.gate(request);

      switch (verdict.action) {
        case "allow":
          logger.debug(`Risk gate allowed ${request.toolName} — ${verdict.reason}`);
          return true;

        case "deny":
          logger.warn(`Risk gate denied ${request.toolName} — ${verdict.reason}`);
          return false;

        case "ask":
          logger.debug(`Risk gate deferred ${request.toolName} — ${verdict.reason}`);
          break;
      }
    }

    return this.promptUser(request);
  }

  /**
   * The mode for one call. A matching deny always wins, whatever else
   * matches: a rule the user wrote to forbid something cannot be outweighed.
   * Otherwise the most specific matching rule decides — a pattern over a
   * tool, a tool over `*` — and among equals the one listed first, which is
   * why an answer of "always" is put at the front.
   */
  private resolveMode(request: PermissionRequest): PermissionMode {
    const target = { toolName: request.toolName, input: request.input, cwd: request.cwd ?? process.cwd() };
    const matching = this.context.rules
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => ruleMatches(rule, target));
    if (matching.some(({ rule }) => rule.mode === "deny")) return "deny";
    matching.sort((a, b) => specificity(b.rule) - specificity(a.rule) || a.index - b.index);
    return matching[0]?.rule.mode ?? this.context.defaultMode;
  }

  /**
   * Ask the user, one question at a time.
   *
   * The agent runs a batch of tool calls concurrently, but a terminal can
   * hold one prompt and the browser shows one approval card; two at once
   * would interleave on stdin or overwrite each other on screen. So prompts
   * queue. A call that waited in the queue may already have been settled by
   * the answer ahead of it — "always allow Bash" answers the next Bash too —
   * so the rules are read again before it is asked.
   */
  private promptUser(request: PermissionRequest): Promise<boolean> {
    const answer = this.promptQueue.then(() => this.promptNow(request));
    this.promptQueue = answer.catch(() => undefined);
    return answer;
  }

  private async promptNow(request: PermissionRequest): Promise<boolean> {
    const settled = this.resolveMode(request);
    if (settled !== "ask") return settled === "allow";

    const decision = await this.prompt(request);

    switch (decision) {
      case "allow":
        return true;

      case "deny":
        return false;

      case "always-allow":
        this.context.rules.unshift({ tool: request.toolName, mode: "allow" });
        logger.info(`Always allowing tool: ${request.toolName}`);
        return true;

      case "always-deny":
        this.context.rules.unshift({ tool: request.toolName, mode: "deny" });
        logger.info(`Always denying tool: ${request.toolName}`);
        return false;
    }
  }

  /** Update permission context */
  update(update: Partial<PermissionContext>): void {
    if (update.defaultMode !== undefined) this.context.defaultMode = update.defaultMode;
    if (update.rules) this.context.rules = [...update.rules, ...this.context.rules];
    if (update.gate !== undefined) this.gate = update.gate;
    if (update.onAsk !== undefined) this.onAsk = update.onAsk;
  }

  /** Install or remove the risk gate. Pass undefined to go back to always asking. */
  setGate(gate: RiskGate | undefined): void {
    this.gate = gate;
  }

  getContext(): PermissionContext {
    return { ...this.context, rules: [...this.context.rules] };
  }
}

/**
 * Default "ask" prompt: a one-shot readline interface on process.stdin.
 *
 * Only safe when nothing else is reading stdin. Hosts that already own the
 * terminal (or have no terminal at all) should pass their own
 * PermissionPrompt instead.
 */
export const stdinPrompt: PermissionPrompt = async (request) => {
  console.log(
    chalk.yellow("\n⚠  Permission required") + chalk.white(` for ${chalk.bold(request.toolName)}`),
  );
  if (request.description) {
    console.log(chalk.gray(`   ${request.description}`));
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(chalk.yellow("   Allow? [y/N/a (always)/d (deny always)]: "));
    return parseDecision(answer);
  } finally {
    rl.close();
  }
};

/** Map a raw answer to a decision. Anything unrecognised denies once. */
export function parseDecision(answer: string): PermissionDecision {
  switch (answer.trim().toLowerCase()) {
    case "y":
    case "yes":
      return "allow";
    case "a":
    case "always":
      return "always-allow";
    case "d":
      return "always-deny";
    default:
      return "deny";
  }
}

/** Convenience factory for common permission presets */
export const PermissionPresets = {
  /** Allow everything without asking */
  allowAll: (): Partial<PermissionContext> => ({
    defaultMode: "allow",
    rules: [],
  }),

  /**
   * Ask before running Bash, writing files, and fetching a URL. WebFetch used
   * to run unasked, which with Read unasked too left one path from a secret on
   * disk to any server, with no prompt on the way.
   */
  askDangerous: (): Partial<PermissionContext> => ({
    defaultMode: "allow",
    rules: [
      { tool: "Bash", mode: "ask" },
      { tool: "Write", mode: "ask" },
      { tool: "Edit", mode: "ask" },
      { tool: "WebFetch", mode: "ask" },
    ],
  }),

  /** Read-only: allow reads, deny writes/shell */
  readOnly: (): Partial<PermissionContext> => ({
    defaultMode: "allow",
    rules: [
      { tool: "Bash", mode: "deny" },
      { tool: "Write", mode: "deny" },
      { tool: "Edit", mode: "deny" },
    ],
  }),
};
