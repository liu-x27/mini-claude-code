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

/**
 * Evaluates whether a tool call is permitted, based on configured rules.
 * In "ask" mode, prompts the user interactively via stdin.
 */
export class PermissionSystem {
  private context: PermissionContext;
  private prompt: PermissionPrompt;
  private gate: RiskGate | undefined;

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
  }

  /**
   * Check if a tool call should be allowed.
   * Returns true if allowed, false if denied.
   * In "ask" mode, interactively prompts the user.
   */
  async check(request: PermissionRequest): Promise<boolean> {
    const mode = this.resolveMode(request.toolName);

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
    if (this.gate) {
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

  private resolveMode(toolName: string): PermissionMode {
    // Specific rule takes precedence over wildcard
    for (const rule of this.context.rules) {
      if (rule.tool === toolName) return rule.mode;
    }
    for (const rule of this.context.rules) {
      if (rule.tool === "*") return rule.mode;
    }
    return this.context.defaultMode;
  }

  private async promptUser(request: PermissionRequest): Promise<boolean> {
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

  /** Ask before running Bash and file writes */
  askDangerous: (): Partial<PermissionContext> => ({
    defaultMode: "allow",
    rules: [
      { tool: "Bash", mode: "ask" },
      { tool: "Write", mode: "ask" },
      { tool: "Edit", mode: "ask" },
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
