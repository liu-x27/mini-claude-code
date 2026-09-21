/**
 * Example 04: Multi-turn Conversation with Session Resume
 *
 * Demonstrates:
 * - Running multiple turns in sequence
 * - Resuming a previous session (full context preserved)
 *
 * Run: bun run examples/04-multi-turn.ts
 */

import { Agent, SessionManager } from "../src/index.js";
import chalk from "chalk";

// ─────────────────────────────────────────────
// Turn 1: First conversation
// ─────────────────────────────────────────────
console.log(chalk.blue("=== Turn 1: Starting new conversation ===\n"));

const agent1 = new Agent({
  model: "claude-opus-5",
  allowedTools: [],
  persistSessions: true,
  systemPrompt: "You are a friendly tutor who teaches step by step.",
});

const result1 = await agent1.run(
  "My name is Alex and I want to learn about TypeScript generics. " +
  "Start with the basics — what is a generic?"
);

console.log(chalk.white(result1.text));
console.log(chalk.gray(`\n[Session: ${result1.sessionId}]\n`));

// ─────────────────────────────────────────────
// Turn 2: Continue in SAME agent (appends to history automatically)
// ─────────────────────────────────────────────
// Note: For true multi-turn within one session, use Agent.resumeSessionId
// OR call agent.run() multiple times with the same session config.
// Here we demonstrate session RESUME across Agent instances.
// ─────────────────────────────────────────────

console.log(chalk.blue("\n=== Turn 2: Resuming session (new Agent instance) ===\n"));

const agent2 = new Agent({
  model: "claude-opus-5",
  allowedTools: [],
  persistSessions: true,
  resumeSessionId: result1.sessionId,  // Resume the previous session
  systemPrompt: "You are a friendly tutor who teaches step by step.",
});

const result2 = await agent2.run(
  "Great! Now can you show me a practical example with a generic function? " +
  "And remember my name from before."
);

console.log(chalk.white(result2.text));
console.log(chalk.gray(`\n[Session: ${result2.sessionId}, Turns: ${result2.turns}]\n`));

// ─────────────────────────────────────────────
// Session history
// ─────────────────────────────────────────────
console.log(chalk.blue("\n=== Session History ===\n"));
const sm = new SessionManager();
const sessions = await sm.list();
console.log(`Found ${sessions.length} saved session(s):`);
for (const s of sessions.slice(0, 5)) {
  console.log(
    chalk.gray(
      `  [${s.updatedAt.slice(0, 19)}] ${s.sessionId.slice(0, 8)}... ` +
      `${s.turns} turns | $${s.totalCost.toFixed(5)}`
    )
  );
}
