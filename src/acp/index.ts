import * as acp from "@agentclientprotocol/sdk";
import { Agent } from "../agent.js";
import { connectMcpServers, type McpConnection, type McpServerConfig } from "../mcp/index.js";
import { PermissionPresets } from "../permissions/index.js";
import { globalRegistry } from "../tools/index.js";
import { ToolRegistry } from "../tools/registry.js";
import type { AgentConfig, AgentEvent, PermissionDecision, PermissionPrompt, PermissionRequest } from "../types.js";

/**
 * This harness as an Agent Client Protocol agent: what an editor (Zed,
 * JetBrains, Neovim…) or a harness such as Harbor drives over stdio.
 *
 * One ACP session is one of this harness's sessions, saved and resumed as
 * any other. The loop's events go out as session/update notifications,
 * permission questions go to the editor as session/request_permission, and
 * session/cancel aborts the run as Ctrl+C does in the CLI.
 */
export interface AcpServerOptions {
  /** The rest of every session's Agent config: client, model, permissions preset, gate, hooks… */
  agent?: Omit<AgentConfig, "cwd" | "resumeSessionId" | "stream">;
}

interface AcpSession {
  cwd: string;
  /** This harness's session id, once the first prompt has made one. */
  saved?: string;
  running?: AbortController | undefined;
  registry: ToolRegistry;
  mcp?: McpConnection;
}

export function serveAcp(stream: acp.Stream, options: AcpServerOptions = {}): acp.AgentSideConnection {
  return new acp.AgentSideConnection((conn) => new AcpAgent(conn, options), stream);
}

class AcpAgent implements acp.Agent {
  private sessions = new Map<string, AcpSession>();

  constructor(
    private conn: acp.AgentSideConnection,
    private options: AcpServerOptions,
  ) {}

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, promptCapabilities: { embeddedContext: true } },
      agentInfo: { name: "mini-claude-code", version: "0.1.0" },
    };
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return {};
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = crypto.randomUUID();
    const session: AcpSession = { cwd: params.cwd, registry: new ToolRegistry().register(...globalRegistry.all()) };
    const servers = mcpConfig(params.mcpServers);
    if (Object.keys(servers).length > 0) {
      session.mcp = await connectMcpServers(servers);
      session.registry.register(...session.mcp.tools);
    }
    this.sessions.set(sessionId, session);
    return { sessionId };
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`no session ${params.sessionId}`);
    session.running?.abort();
    const controller = new AbortController();
    session.running = controller;

    const base = this.options.agent ?? {};
    const agent = new Agent(
      {
        ...base,
        cwd: session.cwd,
        stream: true,
        ...(session.saved ? { resumeSessionId: session.saved } : {}),
        permissions: {
          ...(base.permissions ?? PermissionPresets.askDangerous()),
          prompt: this.askEditor(params.sessionId),
        },
      },
      session.registry,
    );
    let streamed = false;
    agent.on((event) => {
      if (event.type === "text_delta") streamed = true;
      return this.forward(params.sessionId, event);
    });

    try {
      const result = await agent.run(promptText(params.prompt), { signal: controller.signal });
      session.saved = result.sessionId;
      // A client that does not stream still has its answer shown.
      if (!streamed && result.text) {
        await this.conn.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: result.text } },
        });
      }
      return { stopReason: stopReason(result.stopReason) };
    } finally {
      if (session.running === controller) session.running = undefined;
    }
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.running?.abort();
  }

  /** Close every session's MCP servers. */
  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.mcp?.close()));
  }

  /** A permission question, put to the editor. Cancelled or unanswered means no. */
  private askEditor(sessionId: string): PermissionPrompt {
    return async (request: PermissionRequest): Promise<PermissionDecision> => {
      try {
        const answer = await this.conn.requestPermission({
          sessionId,
          toolCall: {
            toolCallId: request.toolUseId ?? crypto.randomUUID(),
            title: `${request.toolName}: ${request.description}`,
            kind: toolKind(request.toolName),
            status: "pending",
            rawInput: request.input,
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "always", name: `Always allow ${request.toolName}`, kind: "allow_always" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        });
        if (answer.outcome.outcome !== "selected") return "deny";
        return answer.outcome.optionId === "allow" ? "allow" : answer.outcome.optionId === "always" ? "always-allow" : "deny";
      } catch {
        return "deny";
      }
    };
  }

  /** The loop's events as session/update notifications. */
  private forward(sessionId: string, event: AgentEvent): Promise<void> | undefined {
    const update = (u: acp.SessionNotification["update"]) => this.conn.sessionUpdate({ sessionId, update: u });
    switch (event.type) {
      case "text_delta":
        return update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.delta } });
      case "thinking_delta":
        return update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.delta } });
      case "tool_request":
        return update({
          sessionUpdate: "tool_call",
          toolCallId: event.toolUseId,
          title: event.toolName,
          kind: toolKind(event.toolName),
          status: "pending",
          rawInput: event.input,
        });
      case "tool_start":
        return update({ sessionUpdate: "tool_call_update", toolCallId: event.toolUseId, status: "in_progress" });
      case "tool_denied":
        return update({
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolUseId,
          status: "failed",
          content: [{ type: "content", content: { type: "text", text: `Not run: ${event.reason}` } }],
        });
      case "tool_end": {
        const text = event.result.type === "success" ? event.result.output : event.result.message;
        return update({
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolUseId,
          status: event.result.type === "success" ? "completed" : "failed",
          content: [{ type: "content", content: { type: "text", text: text.slice(0, 4000) } }],
        });
      }
      case "todos":
        return update({
          sessionUpdate: "plan",
          entries: event.todos.map((t) => ({ content: t.content, priority: "medium", status: t.status })),
        });
      default:
        return undefined;
    }
  }
}

/** The prompt's text: text blocks as they are, embedded resources inlined, links named. */
function promptText(blocks: acp.ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "resource_link") parts.push(`[${b.name}](${b.uri})`);
    else if (b.type === "resource" && "text" in b.resource) parts.push(`<resource uri="${b.resource.uri}">\n${b.resource.text}\n</resource>`);
  }
  return parts.join("\n\n");
}

function toolKind(name: string): acp.ToolKind {
  switch (name) {
    case "Read":
      return "read";
    case "Glob":
    case "Grep":
      return "search";
    case "Write":
    case "Edit":
      return "edit";
    case "Bash":
      return "execute";
    case "WebFetch":
      return "fetch";
    case "TodoWrite":
      return "think";
    default:
      return "other";
  }
}

function stopReason(reason: string): acp.StopReason {
  switch (reason) {
    case "end_turn":
    case "max_tokens":
    case "refusal":
      return reason;
    case "max_turns":
      return "max_turn_requests";
    case "aborted":
      return "cancelled";
    default:
      return "end_turn";
  }
}

/** The MCP servers an editor hands to session/new, in the shape connectMcpServers takes. */
function mcpConfig(servers: acp.McpServer[]): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const s of servers) {
    if ("type" in s && s.type === "http") {
      out[s.name] = { type: "http", url: s.url, headers: Object.fromEntries(s.headers.map((h) => [h.name, h.value])) };
    } else if (!("type" in s) || s.type === undefined) {
      const stdio = s as acp.McpServerStdio;
      out[stdio.name] = {
        command: stdio.command,
        args: stdio.args,
        env: Object.fromEntries(stdio.env.map((e) => [e.name, e.value])),
      };
    }
  }
  return out;
}
