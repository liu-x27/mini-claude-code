// A two-tool MCP server over stdio, for the mock suite: `shout` is read-only, `fail` always errors.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fixture", version: "1.0.0" });

server.registerTool(
  "shout",
  { description: "Upper-case the text", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: "text", text: text.toUpperCase() }] }),
);

server.registerTool("fail", { description: "Always fails", inputSchema: {} }, async () => ({
  content: [{ type: "text", text: "nope" }],
  isError: true,
}));

await server.connect(new StdioServerTransport());
