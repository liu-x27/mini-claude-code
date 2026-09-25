import { setLogger as setJudgeLogger } from "xavierjev";

import chalk from "chalk";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

class Logger {
  private level: LogLevel;

  constructor(level: LogLevel = "info") {
    this.level = level;
  }

  setLevel(level: LogLevel) {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVELS[level] >= LEVELS[this.level];
  }

  private timestamp(): string {
    return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  }

  debug(msg: string, ...args: unknown[]) {
    if (this.shouldLog("debug")) {
      console.debug(chalk.gray(`[${this.timestamp()}] DBG  ${msg}`), ...args);
    }
  }

  info(msg: string, ...args: unknown[]) {
    if (this.shouldLog("info")) {
      console.info(chalk.blue(`[${this.timestamp()}] INFO ${msg}`), ...args);
    }
  }

  warn(msg: string, ...args: unknown[]) {
    if (this.shouldLog("warn")) {
      console.warn(chalk.yellow(`[${this.timestamp()}] WARN ${msg}`), ...args);
    }
  }

  error(msg: string, ...args: unknown[]) {
    if (this.shouldLog("error")) {
      console.error(chalk.red(`[${this.timestamp()}] ERR  ${msg}`), ...args);
    }
  }

  /** Print a tool call banner */
  tool(toolName: string, summary?: string) {
    if (this.shouldLog("info")) {
      const label = chalk.cyan(`⚙  ${toolName}`);
      const detail = summary ? chalk.gray(` — ${summary}`) : "";
      console.log(`${label}${detail}`);
    }
  }

  /** Print a thinking indicator */
  thinking() {
    if (this.shouldLog("debug")) {
      console.log(chalk.magenta("💭 Thinking..."));
    }
  }
}

/** Singleton logger — import and use directly */
export const logger = new Logger((process.env.AGENT_LOG_LEVEL as LogLevel | undefined) ?? "info");

// The decision layer comes from xavierjev and logs to the console unless its
// host hands it a logger. This one keeps its warnings with the framework's,
// and keeps setLevel() quieting both.
setJudgeLogger(logger);
