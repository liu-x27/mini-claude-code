/**
 * Example 03: Streaming Output
 *
 * Shows tokens as they arrive from the API.
 * Also demonstrates adaptive thinking visualization.
 *
 * Run: bun run examples/03-streaming.ts
 */

import { Agent } from "../src/index.js";
import chalk from "chalk";

const agent = new Agent({
  model: "claude-opus-5",
  thinking: { type: "adaptive" },
  effort: "high",
  allowedTools: ["WebFetch"],
});

let thinkingActive = false;
let textStarted = false;

agent.on(async (event) => {
  switch (event.type) {
    case "thinking_delta":
      if (!thinkingActive) {
        process.stdout.write(chalk.magenta("\n[Thinking] "));
        thinkingActive = true;
      }
      process.stdout.write(chalk.magenta(event.delta));
      break;

    case "text_delta":
      if (thinkingActive) {
        process.stdout.write("\n");
        thinkingActive = false;
      }
      if (!textStarted) {
        process.stdout.write(chalk.green("\n[Response]\n"));
        textStarted = true;
      }
      process.stdout.write(event.delta);
      break;

    case "tool_start":
      process.stdout.write(chalk.cyan(`\n\n[Tool: ${event.toolName}]\n`));
      break;

    case "done":
      const { usage } = event.result;
      process.stdout.write(
        chalk.gray(
          `\n\n---\nTokens: ${usage.inputTokens} in / ${usage.outputTokens} out` +
          `  |  Cache: ${usage.cacheReadTokens} read / ${usage.cacheCreationTokens} created` +
          `  |  Cost: $${usage.estimatedCostUsd.toFixed(5)}\n`
        )
      );
      break;
  }
});

await agent.run(
  "Explain the difference between an AI agent and a simple LLM call. " +
  "What makes something truly 'agentic'?"
);
