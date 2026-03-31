/**
 * Example 05: Custom Tools & Subagent Pattern
 *
 * Demonstrates:
 * - Creating and registering a custom tool
 * - Orchestrating parallel work via multiple Agent instances
 * - Aggregating results from sub-tasks
 *
 * Run: bun run examples/05-subagents.ts
 */

import { Agent, Tool, globalRegistry } from "../src/index.js";
import type { ToolContext, ToolInputSchema, ToolResult } from "../src/index.js";
import chalk from "chalk";

// ─────────────────────────────────────────────
// Custom Tool: Calculator
// ─────────────────────────────────────────────
interface CalcInput {
  expression: string;
}

class CalculatorTool extends Tool<CalcInput> {
  readonly name = "Calculator";
  readonly description =
    "Evaluate a mathematical expression and return the result. " +
    "Supports basic arithmetic, Math functions, and JavaScript expressions.";

  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "Math expression to evaluate (e.g., '2 ** 10', 'Math.sqrt(144)')",
      },
    },
    required: ["expression"],
  };

  async execute(input: CalcInput, _ctx: ToolContext): Promise<ToolResult> {
    try {
      // Safe evaluation limited to math operations
      const allowed = /^[\d\s+\-*/().^%,Mathsqrpowabceilfloorndlogiex]+$/;
      if (!allowed.test(input.expression.replace(/\s/g, ""))) {
        return { type: "error", message: "Expression contains disallowed characters" };
      }
      const result = Function(`"use strict"; return (${input.expression})`)();
      return { type: "success", output: String(result) };
    } catch (err) {
      return { type: "error", message: `Evaluation error: ${String(err)}` };
    }
  }
}

// Register the custom tool
globalRegistry.register(new CalculatorTool());

// ─────────────────────────────────────────────
// Subagent Pattern: Parallel specialized agents
// ─────────────────────────────────────────────

async function runSubagent(name: string, task: string, tools: string[]): Promise<string> {
  const agent = new Agent({
    model: "claude-opus-4-6",
    allowedTools: tools,
    persistSessions: false,
    systemPrompt: `You are a specialized subagent: ${name}. Be concise and direct.`,
    maxTurns: 5,
  });
  const result = await agent.run(task);
  return result.text;
}

console.log(chalk.blue("=== Parallel Subagent Demo ===\n"));
console.log("Spawning 3 specialized subagents in parallel...\n");

// Run three specialized agents concurrently
const [mathResult, summaryResult, codeResult] = await Promise.all([
  runSubagent(
    "Math Expert",
    "Calculate: What is 2^32? And what is the square root of 999983?",
    ["Calculator"]
  ),
  runSubagent(
    "Summarizer",
    "Summarize the concept of 'agent orchestration' in exactly 2 sentences.",
    []
  ),
  runSubagent(
    "Code Reviewer",
    "What are 3 common mistakes when writing async TypeScript code? List them briefly.",
    []
  ),
]);

console.log(chalk.yellow("🔢 Math Expert:"));
console.log(mathResult);
console.log();

console.log(chalk.green("📝 Summarizer:"));
console.log(summaryResult);
console.log();

console.log(chalk.cyan("👨‍💻 Code Reviewer:"));
console.log(codeResult);
console.log();

// ─────────────────────────────────────────────
// Orchestrator: Synthesize all results
// ─────────────────────────────────────────────
console.log(chalk.blue("=== Orchestrator Synthesis ===\n"));

const orchestrator = new Agent({
  model: "claude-opus-4-6",
  allowedTools: [],
  persistSessions: false,
});

const synthesis = await orchestrator.run(
  `I have collected outputs from 3 specialized subagents. Synthesize these into a coherent response:

  MATH RESULT:
  ${mathResult}

  CONCEPT SUMMARY:
  ${summaryResult}

  CODE BEST PRACTICES:
  ${codeResult}

  Please combine these insights into a brief technical update (3-4 sentences).`
);

console.log(chalk.white(synthesis.text));
