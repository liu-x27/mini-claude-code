/**
 * Example 06: Custom Tool — Database Query (Mock)
 *
 * Shows how to build a domain-specific tool and integrate it with an agent.
 * This example mocks a database but shows the full pattern.
 *
 * Run: bun run examples/06-custom-tool.ts
 */

import { Agent, Tool, ToolRegistry } from "../src/index.js";
import type { ToolContext, ToolInputSchema, ToolResult } from "../src/index.js";
import chalk from "chalk";

// ─────────────────────────────────────────────
// Mock in-memory database
// ─────────────────────────────────────────────
const DB: Record<string, Record<string, unknown>[]> = {
  users: [
    { id: 1, name: "Alice", email: "alice@example.com", role: "admin", createdAt: "2024-01-15" },
    { id: 2, name: "Bob", email: "bob@example.com", role: "user", createdAt: "2024-02-20" },
    { id: 3, name: "Carol", email: "carol@example.com", role: "user", createdAt: "2024-03-01" },
  ],
  orders: [
    { id: 101, userId: 1, product: "Widget A", amount: 49.99, status: "shipped" },
    { id: 102, userId: 2, product: "Widget B", amount: 29.99, status: "pending" },
    { id: 103, userId: 1, product: "Widget C", amount: 99.99, status: "delivered" },
    { id: 104, userId: 3, product: "Widget A", amount: 49.99, status: "pending" },
  ],
};

// ─────────────────────────────────────────────
// Custom DB Query Tool
// ─────────────────────────────────────────────
interface DbQueryInput {
  table: string;
  filter?: Record<string, unknown>;
  limit?: number;
}

class DatabaseQueryTool extends Tool<DbQueryInput> {
  readonly name = "QueryDatabase";
  readonly description =
    "Query the application database. Available tables: users, orders. " +
    "Optionally filter by field values.";

  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      table: {
        type: "string",
        description: "Table to query: 'users' or 'orders'",
        enum: ["users", "orders"],
      },
      filter: {
        type: "object",
        description: "Key-value pairs to filter rows (e.g., {role: 'admin'})",
        properties: {},
      },
      limit: {
        type: "number",
        description: "Maximum rows to return (default: 10)",
      },
    },
    required: ["table"],
  };

  async execute(input: DbQueryInput, _ctx: ToolContext): Promise<ToolResult> {
    const table = DB[input.table];
    if (!table) {
      return { type: "error", message: `Unknown table: ${input.table}` };
    }

    let rows = [...table];

    // Apply filter
    if (input.filter) {
      rows = rows.filter((row) =>
        Object.entries(input.filter!).every(([k, v]) => row[k] === v)
      );
    }

    // Apply limit
    const limit = input.limit ?? 10;
    rows = rows.slice(0, limit);

    if (rows.length === 0) {
      return { type: "success", output: "No rows found." };
    }

    const json = JSON.stringify(rows, null, 2);
    return { type: "success", output: `Found ${rows.length} row(s):\n${json}` };
  }
}

// ─────────────────────────────────────────────
// Build a custom registry with only our tool
// ─────────────────────────────────────────────
const registry = new ToolRegistry();
registry.register(new DatabaseQueryTool());

const agent = new Agent(
  {
    model: "claude-opus-4-6",
    systemPrompt: "You are a data analyst assistant. Query the database to answer questions.",
    persistSessions: false,
    allowedTools: ["QueryDatabase"],
  },
  registry
);

agent.on(async (event) => {
  if (event.type === "tool_start") {
    console.log(chalk.cyan(`  📊 QueryDatabase(${JSON.stringify(event.input)})`));
  }
});

console.log(chalk.blue("Question: Who are our admin users and what have they ordered?\n"));

const result = await agent.run(
  "Who are the admin users in our system? " +
  "And what orders do they have? Show me a summary."
);

console.log(chalk.white(result.text));
console.log(chalk.gray(`\n[${result.turns} turns, ${result.toolCalls.length} tool calls]`));
