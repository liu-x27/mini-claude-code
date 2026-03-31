/**
 * Example 01: Basic Agent Query
 *
 * The simplest possible usage — send a prompt, get a result.
 * No tools enabled, just a direct conversation with Claude.
 *
 * Run: bun run examples/01-basic.ts
 */

import { Agent } from "../src/index.js";

const agent = new Agent({
  model: "claude-opus-4-6",
  thinking: { type: "adaptive" },
  allowedTools: [], // No tools for this basic example
});

const result = await agent.run(
  "What are the key principles of building a good AI agent system? " +
  "List 5 principles with a brief explanation for each."
);

console.log("=== Agent Response ===\n");
console.log(result.text);
console.log("\n=== Stats ===");
console.log(`Turns: ${result.turns}`);
console.log(`Input tokens: ${result.usage.inputTokens}`);
console.log(`Output tokens: ${result.usage.outputTokens}`);
console.log(`Cost: $${result.usage.estimatedCostUsd.toFixed(5)}`);
console.log(`Session ID: ${result.sessionId}`);
