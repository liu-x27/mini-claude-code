import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Tool } from "../tools/base.js";
import type { Validated } from "../tools/validate.js";
import type { ToolContext, ToolInputSchema, ToolResult } from "../types.js";

/**
 * One MCP server, in the shape of Claude Code's `.mcp.json`: a command to
 * spawn and talk to over stdio, or the URL of a streamable-HTTP endpoint.
 */
export type McpServerConfig =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: "http"; url: string; headers?: Record<string, string> };

export interface McpConnection {
  /** Every tool of every server that connected, named `mcp__<server>__<tool>`. */
  tools: Tool[];
  /** Servers that could not be reached, and why; the rest still work. */
  failures: Array<{ server: string; error: string }>;
  close(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 30_000;
const CLIENT_INFO = { name: "mini-claude-code", version: "0.1.0" };

/**
 * Connect to each server and wrap its tools as this harness's own.
 *
 * A server that fails to start or answer is reported in `failures` and left
 * out, rather than taking the others down with it.
 */
export async function connectMcpServers(servers: Record<string, McpServerConfig>): Promise<McpConnection> {
  const clients: Client[] = [];
  const tools: Tool[] = [];
  const failures: McpConnection["failures"] = [];
  const taken = new Set<string>();

  await Promise.all(
    Object.entries(servers).map(async ([server, config]) => {
      const client = new Client(CLIENT_INFO);
      try {
        const transport =
          config.type === "http"
            ? new StreamableHTTPClientTransport(new URL(config.url), {
                requestInit: { headers: config.headers ?? {} },
              })
            : new StdioClientTransport({
                command: config.command,
                ...(config.args ? { args: config.args } : {}),
                env: { ...getDefaultEnvironment(), ...config.env },
                ...(config.cwd ? { cwd: config.cwd } : {}),
                stderr: "ignore",
              });
        // The SDK's transport types are written without exactOptionalPropertyTypes.
        const connecting = client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
        await withTimeout(connecting, CONNECT_TIMEOUT_MS, `${server} did not answer`);
        clients.push(client);

        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : {});
          for (const def of page.tools) {
            const name = uniqueName(`mcp__${server}__${def.name}`, taken);
            tools.push(new McpTool(client, name, def));
          }
          cursor = page.nextCursor;
        } while (cursor);
      } catch (err) {
        failures.push({ server, error: err instanceof Error ? err.message : String(err) });
        await client.close().catch(() => undefined);
      }
    }),
  );

  return {
    tools,
    failures,
    close: async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    },
  };
}

interface RemoteTool {
  name: string;
  description?: string | undefined;
  inputSchema: { type: "object"; properties?: Record<string, object> | undefined; required?: string[] | undefined };
  annotations?: { readOnlyHint?: boolean | undefined } | undefined;
}

/**
 * A tool served by an MCP server.
 *
 * Only a tool its server marks readOnlyHint runs alongside others; every
 * other one is treated as dangerous, so it runs alone and in order, like
 * Bash. The ask preset asks before every `mcp__` tool; `--allow` a name to
 * stop that.
 */
class McpTool extends Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
  override readonly dangerous: boolean;

  constructor(
    private client: Client,
    name: string,
    private remote: RemoteTool,
  ) {
    super();
    this.name = name;
    this.description = remote.description ?? `${remote.name}, from an MCP server`;
    this.inputSchema = remote.inputSchema as unknown as ToolInputSchema;
    this.dangerous = remote.annotations?.readOnlyHint !== true;
  }

  /**
   * An object, and the rest is the server's to check: MCP schemas use JSON
   * Schema freely (integers, unions, nesting) and the server validates what
   * it declared.
   */
  override validate(input: unknown): Validated {
    return typeof input === "object" && input !== null && !Array.isArray(input)
      ? { ok: true, value: input as Record<string, unknown> }
      : { ok: false, error: "input must be a JSON object" };
  }

  override async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const result = await this.client.callTool({ name: this.remote.name, arguments: input });
    const text = renderContent(result as { content?: unknown; structuredContent?: unknown; toolResult?: unknown });
    return result.isError
      ? { type: "error", message: text || "the tool reported an error" }
      : { type: "success", output: text || "(no output)" };
  }

  override summarize(input: Record<string, unknown>): string {
    return JSON.stringify(input).slice(0, 80);
  }
}

/** A tool result's content, as text. */
function renderContent(result: { content?: unknown; structuredContent?: unknown; toolResult?: unknown }): string {
  const parts: string[] = [];
  const blocks = Array.isArray(result.content) ? (result.content as Array<Record<string, unknown>>) : [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "image" || b.type === "audio") parts.push(`[${String(b.type)}: ${String(b.mimeType ?? "")}]`);
    else if (b.type === "resource_link") parts.push(`[resource: ${String(b.uri ?? "")}]`);
    else if (b.type === "resource") {
      const r = (b.resource ?? {}) as Record<string, unknown>;
      parts.push(typeof r.text === "string" ? r.text : `[resource: ${String(r.uri ?? "")}]`);
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  if (parts.length === 0 && result.toolResult !== undefined) parts.push(JSON.stringify(result.toolResult));
  return parts.join("\n");
}

/** Tool names the model APIs accept: letters, digits, _ and -, at most 64. */
function uniqueName(raw: string, taken: Set<string>): string {
  const base = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base.slice(0, 60)}_${i}`;
  taken.add(name);
  return name;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${message} within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
