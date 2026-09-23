import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient } from "./model/types.js";

// ─────────────────────────────────────────────
// Model & API
// ─────────────────────────────────────────────

export type ModelId =
  | "claude-opus-5"
  | "claude-sonnet-5"
  | "claude-haiku-4-5"
  | "claude-opus-4-6"
  | "claude-sonnet-4-6"
  | (string & {});

export type ThinkingConfig =
  | { type: "adaptive" }
  | { type: "enabled"; budget_tokens: number }
  | { type: "disabled" };

export type EffortLevel = "low" | "medium" | "high" | "max";

// ─────────────────────────────────────────────
// Tool System
// ─────────────────────────────────────────────

/** JSON Schema for a tool's input parameters */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface JsonSchemaProperty {
  type: "string" | "number" | "boolean" | "array" | "object" | "null";
  description?: string;
  enum?: (string | number | boolean)[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  default?: unknown;
}

/** Result returned from a tool execution */
export type ToolResult = { type: "success"; output: string } | { type: "error"; message: string };

/** Execution context passed to each tool */
export interface ToolContext {
  cwd: string;
  sessionId: string;
  agentId: string;
  permissions: PermissionContext;
}

// ─────────────────────────────────────────────
// Permission System
// ─────────────────────────────────────────────

export type PermissionMode = "allow" | "ask" | "deny";

export interface PermissionRule {
  tool: string; // tool name or "*" wildcard
  mode: PermissionMode;
  /** Optional glob pattern for file-based tools */
  pathPattern?: string;
}

export interface PermissionContext {
  defaultMode: PermissionMode;
  rules: PermissionRule[];
  /**
   * How to ask the user when a tool resolves to "ask" mode.
   * Defaults to a prompt on process.stdin.
   */
  prompt?: PermissionPrompt;
  /**
   * Optional filter consulted before asking the user, to answer the easy
   * cases without a prompt. Off by default.
   */
  gate?: RiskGate;
}

export type PermissionDecision = "allow" | "deny" | "always-allow" | "always-deny";

/**
 * Asks the user to decide on a single tool call.
 *
 * Injectable because process.stdin is the wrong channel for most hosts: the
 * HTTP server would block a request handler on the server process's stdin,
 * and a REPL already owns a readline interface that a second one would
 * compete with for keystrokes.
 */
export type PermissionPrompt = (request: PermissionRequest) => Promise<PermissionDecision>;

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  description: string;
  /**
   * The tool call being asked about, when there is one. The agent runs a
   * batch of calls concurrently, so a host that reports verdicts or shows
   * approval cards needs this to tell them apart.
   */
  toolUseId?: string | undefined;
}

/**
 * Decides a call that already resolved to "ask", so that the user only sees
 * the ones worth seeing.
 *
 * A gate is consulted *after* the static rules, never instead of them, and it
 * is never asked about a call the rules already settled — so it cannot widen
 * what runs, only narrow what gets asked about. Anything it is unsure of, and
 * every way it can fail, comes back as "ask".
 */
export type RiskGate = (request: PermissionRequest) => Promise<GateVerdict>;

export interface GateVerdict {
  action: PermissionMode;
  /**
   * The probability the decision was made on, or undefined when the gate
   * never got a usable answer out of its backend.
   */
  probability: number | undefined;
  /** Short explanation, for logs and eval output. */
  reason: string;
  /**
   * Every question's answer, in the order they were asked, when the backend
   * gave a complete and valid set. The decision is made on the worst of
   * them; the rest are there so a UI can show which harm held a call and
   * which ones were never in doubt.
   */
  answers?: Array<{ id: string; probability: number }> | undefined;
  /** How long the backend took to answer, in milliseconds. */
  latencyMs?: number | undefined;
  /** The auto-allow threshold the verdict was made against. */
  threshold?: number | undefined;
}

/**
 * Picks the model for a run, once, from the user's prompt.
 *
 * The gate's sibling: same backend, same fail-closed rule, pointed at cost
 * instead of at safety. Every way it can fail resolves to the expensive
 * model — see `createModelRouter`.
 */
export type ModelRouter = (prompt: string) => Promise<RouteVerdict>;

export interface RouteVerdict {
  model: ModelId;
  /** True when the router picked the cheaper model. */
  downgraded: boolean;
  /** P(needs the strong model), or undefined when the judge gave no answer. */
  probability: number | undefined;
  reason: string;
}

// ─────────────────────────────────────────────
// Session & Conversation
// ─────────────────────────────────────────────

export type MessageRole = "user" | "assistant";

export interface ConversationMessage {
  role: MessageRole;
  content: Anthropic.MessageParam["content"];
}

export interface SessionMetadata {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  model: ModelId;
  cwd: string;
  title?: string;
  tags?: string[];
  turns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
}

export interface Session {
  metadata: SessionMetadata;
  messages: ConversationMessage[];
}

// ─────────────────────────────────────────────
// Agent Configuration
// ─────────────────────────────────────────────

export interface AgentConfig {
  /**
   * The model API to call. Defaults to an `AnthropicClient` configured from
   * the environment; pass an `OpenAICompatibleClient` for any Chat
   * Completions endpoint, or a scripted one in tests.
   */
  client?: ModelClient;

  /** Claude model to use (default: claude-opus-5) */
  model?: ModelId;

  /** Custom system prompt (appended to base prompt) */
  systemPrompt?: string;

  /** Working directory for file/shell operations */
  cwd?: string;

  /** Max number of agentic turns before stopping */
  maxTurns?: number;

  /** Max output tokens per API call */
  maxTokens?: number;

  /** Thinking configuration */
  thinking?: ThinkingConfig;

  /** Effort level for thinking */
  effort?: EffortLevel;

  /** Names of tools to enable (defaults to all registered tools) */
  allowedTools?: string[];

  /** Names of tools to explicitly disable */
  disallowedTools?: string[];

  /** Permission configuration */
  permissions?: Partial<PermissionContext>;

  /** Session ID to resume (optional) */
  resumeSessionId?: string;

  /** Whether to persist sessions to disk */
  persistSessions?: boolean;

  /** Session storage directory */
  sessionDir?: string;

  /** Subagent definitions */
  subagents?: Record<string, SubagentDefinition>;

  /** Enable prompt caching (default: true) */
  enableCaching?: boolean;

  /** Stream output tokens as they arrive */
  stream?: boolean;

  /**
   * Optional router consulted once, before the first turn, to pick the model.
   *
   * Off by default. When set it overrides `model` for the whole run — see
   * `createModelRouter`, which decides between exactly two tiers and falls
   * back to the expensive one on any failure.
   */
  router?: ModelRouter;
}

export interface SubagentDefinition {
  /** Display description of this subagent */
  description: string;
  /** System prompt override for the subagent */
  systemPrompt?: string;
  /** Tools available to this subagent */
  allowedTools?: string[];
  /** Model override for this subagent */
  model?: ModelId;
}

// ─────────────────────────────────────────────
// Agent Run Result
// ─────────────────────────────────────────────

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  estimatedCostUsd: number;
}

export interface RunOptions {
  /**
   * Stops the run: the model call in flight is cancelled, tool calls not yet
   * started are skipped, and no further turn begins. The run then returns
   * normally with `stopReason: "aborted"` and the session saved up to that
   * point, so it can be resumed.
   */
  signal?: AbortSignal | undefined;
}

export interface AgentResult {
  /** Final text response from the agent */
  text: string;
  /**
   * Stop reason from the last API call, or "max_turns" when the turn limit
   * cut the run short, or "aborted" when the caller's signal did.
   */
  stopReason: string;
  /** Number of agentic turns taken */
  turns: number;
  /** Tool calls made during this run */
  toolCalls: ToolCallRecord[];
  /** Token usage stats */
  usage: AgentUsage;
  /** Session ID (useful for resuming) */
  sessionId: string;
}

export interface ToolCallRecord {
  toolName: string;
  input: Record<string, unknown>;
  result: ToolResult;
  durationMs: number;
}

// ─────────────────────────────────────────────
// Events (for streaming / hooks)
// ─────────────────────────────────────────────

/**
 * Every tool call the model makes produces `tool_request` first, then either
 * `tool_denied` (it never ran) or `tool_start` and `tool_end`. All three
 * carry the call's `toolUseId`: calls in a batch run concurrently, so their
 * events interleave.
 */
export type AgentEvent =
  | { type: "session"; sessionId: string; resumed: boolean }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_request"; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: "tool_denied"; toolUseId: string; toolName: string; reason: string }
  | { type: "tool_start"; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | {
      type: "tool_end";
      toolUseId: string;
      toolName: string;
      result: ToolResult;
      durationMs: number;
    }
  | { type: "turn_start"; turn: number }
  | { type: "turn_end"; turn: number; usage: AgentUsage }
  | { type: "done"; result: AgentResult };

export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;

// ─────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
