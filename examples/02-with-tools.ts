/**
 * Example 02: Agent with File System Tools
 *
 * Agent can read files, search for patterns, and explore the codebase.
 * Demonstrates the agentic loop: Claude decides which tools to call.
 *
 * Run: bun run examples/02-with-tools.ts
 */

import { Agent } from "../src/index.js";

const agent = new Agent({
  model: "claude-opus-4-6",
  cwd: process.cwd(),
  allowedTools: ["Read", "Glob", "Grep"],  // Read-only tools
  persistSessions: true,
  systemPrompt: "You are a code analysis assistant. Be concise and precise.",
});

// Listen to events for visibility
agent.on(async (event) => {
  if (event.type === "tool_start") {
    console.log(`  🔧 ${event.toolName}(${JSON.stringify(event.input).slice(0, 60)}...)`);
  }
  if (event.type === "tool_end" && event.result.type === "error") {
    console.log(`  ❌ Error: ${event.result.message}`);
  }
});

console.log("Asking agent to analyze this project...\n");

const result = await agent.run(
  `Explore the project in the current directory (D:/CODE/agent-app).
   Tell me:
   1. What is this project?
   2. List the main source files
   3. What tools are available?`
);

console.log("\n=== Analysis ===\n");
console.log(result.text);
console.log(`\n[${result.turns} turns, ${result.toolCalls.length} tool calls]`);
console.log(`Session: ${result.sessionId}`);
