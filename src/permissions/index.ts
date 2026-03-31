import * as readline from "node:readline/promises";
import type { PermissionContext, PermissionMode, PermissionRequest } from "../types.js";
import { logger } from "../utils/logger.js";
import chalk from "chalk";

/**
 * Evaluates whether a tool call is permitted, based on configured rules.
 * In "ask" mode, prompts the user interactively via stdin.
 */
export class PermissionSystem {
  private context: PermissionContext;

  constructor(context?: Partial<PermissionContext>) {
    this.context = {
      defaultMode: context?.defaultMode ?? "allow",
      rules: context?.rules ?? [],
    };
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
        return this.promptUser(request);
    }
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
    console.log(
      chalk.yellow("\n⚠  Permission required") +
        chalk.white(` for ${chalk.bold(request.toolName)}`)
    );
    if (request.description) {
      console.log(chalk.gray(`   ${request.description}`));
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      const answer = await rl.question(
        chalk.yellow("   Allow? [y/N/a (always)/d (deny always)]: ")
      );
      const trimmed = answer.trim().toLowerCase();

      switch (trimmed) {
        case "y":
        case "yes":
          return true;

        case "a":
        case "always":
          // Add an allow rule for this tool so we don't ask again
          this.context.rules.unshift({ tool: request.toolName, mode: "allow" });
          logger.info(`Always allowing tool: ${request.toolName}`);
          return true;

        case "d":
          this.context.rules.unshift({ tool: request.toolName, mode: "deny" });
          logger.info(`Always denying tool: ${request.toolName}`);
          return false;

        default:
          return false;
      }
    } finally {
      rl.close();
    }
  }

  /** Update permission context */
  update(update: Partial<PermissionContext>): void {
    if (update.defaultMode !== undefined) this.context.defaultMode = update.defaultMode;
    if (update.rules) this.context.rules = [...update.rules, ...this.context.rules];
  }

  getContext(): PermissionContext {
    return { ...this.context, rules: [...this.context.rules] };
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
