import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient } from "./model/types.js";
import type {
  GateVerdict,
  ModelRouter,
  PermissionMode,
  PermissionRequest,
  RetryJudge,
  RetryVerdict,
  RiskGate,
  RouteVerdict,
  RunTrace,
  StopJudge,
  StopVerdict,
  ToolFailure,
  TracedCall,
} from "xavierjev";
import type { HooksConfig } from "./hooks/index.js";

// ─────────────────────────────────────────────
// Model & API
// ─────────────────────────────────────────────

export type ModelId =
  | "claude-opus-5-5"
  | "claude-sonnet-5-5"
  | "claude-fable-5-1"
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

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

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

/** One item of the model's task list (the TodoWrite tool). */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** Execution context passed to each tool */
export interface ToolContext {
  cwd: string;
  sessionId: string;
  agentId: string;
  permissions: PermissionContext;
  /** Where TodoWrite keeps the task list: the session. */
  todos?: { set(items: TodoItem[]): void };
}

// ─────────────────────────────────────────────
// Permission System
// ─────────────────────────────────────────────

// What the loop asks its judge — may this call run without a prompt, which
// model takes this request, is this failure worth another try, is this run
// stuck — is defined with the judge, in xavierjev, so the two cannot drift.
export type {
  GateVerdict,
  ModelRouter,
  PermissionMode,
  PermissionRequest,
  RetryJudge,
  RetryVerdict,
  RiskGate,
  RouteVerdict,
  RunTrace,
  StopJudge,
  StopVerdict,
  ToolFailure,
  TracedCall,
};

export interface PermissionRule {
  tool: string; // tool name or "*" wildcard
  mode: PermissionMode;
  /**
   * What the rule is about, in Claude Code's syntax (`parseRule` reads the
   * whole `Tool(pattern)` form): a command pattern for Bash (`npm test *`), a
   * path glob for Read/Glob/Grep and Edit/Write (`src/**`, `~/.ssh/**`), or
   * `domain:example.com` for WebFetch. Without one the rule covers the tool.
   */
  pattern?: string;
  /** The old name for `pattern`, which it used to be declared as and was never read. */
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
  /**
   * Asked first when a call would otherwise go to the gate and the user —
   * the PermissionRequest hook. Undefined means it has no answer.
   */
  onAsk?: (request: PermissionRequest) => Promise<"allow" | "deny" | undefined>;
  /**
   * The tools the gate may answer for. Default: Bash, the one tool its
   * questions and threshold were measured on; any other call it is asked
   * about goes to the user. Widen it only with numbers for the new tool.
   */
  gateTools?: string[];
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
  /** Null once any run in the session used a model with no price in `utils/cost.ts`. */
  totalCost: number | null;
  /**
   * Why the last run ended early, when it did: the API failed, or the caller
   * aborted it. The next run tells the model before its prompt, since a tool
   * call in flight at that moment may have partly happened.
   */
  interrupted?: string;
  /**
   * The working directory and date the model was last told. They used to sit
   * in the system prompt, which then changed every day and on every /cwd,
   * throwing away the prompt cache (and, on models that bind thinking to
   * the prompt, invalidating earlier thinking); now they are appended to the
   * conversation when they change.
   */
  environment?: string;
  /** Prompt tokens of the last model call, which decides whether the next run starts by compacting. */
  contextTokens?: number;
  /** How many times this session has been compacted. */
  compactions?: number;
  /** The task list the model last wrote with TodoWrite. */
  todos?: TodoItem[];
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

  /** Claude model to use (default: claude-opus-5-5) */
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

  /**
   * Sent as `output_config.effort` when set; omitted otherwise, so the model's
   * own default applies (`medium` on Claude Opus 5.5, `high` on most others).
   * Not every model or compatible endpoint accepts it: Haiku 4.5 rejects it.
   */
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

  /**
   * Subagent types the Task tool offers besides "general-purpose". The Task
   * tool is there unless `disallowedTools` names it (or `allowedTools` leaves
   * it out); a subagent never gets one of its own.
   */
  subagents?: Record<string, SubagentDefinition>;

  /** Enable prompt caching (default: true) */
  enableCaching?: boolean;

  /**
   * Read AGENTS.md / CLAUDE.md from the repository root down to `cwd` (and
   * `~/.agent-app/AGENTS.md`) into the first message of a new session.
   * Default: true.
   */
  projectInstructions?: boolean;

  /**
   * Offer the Agent Skills found under `.agents/skills`, `.claude/skills` and
   * `.agent-app/skills` (in the project, then the home directory): a new
   * session is told their names and descriptions, and a Skill tool loads one
   * when the model asks. Default: true.
   */
  skills?: boolean;

  /**
   * Compact the conversation when a model call's prompt reaches this many
   * tokens: the model summarises it, the full transcript is archived, and
   * the next call starts from the summary. Default: 80% of the model's
   * context window, at most 150K. `false` never compacts.
   */
  compactAt?: number | false;

  /**
   * Lifecycle hooks in Claude Code's format (SessionStart, UserPromptSubmit,
   * PreToolUse, PermissionRequest, PostToolUse, Stop), so its hook scripts and
   * settings work here unchanged. See `src/hooks`.
   */
  hooks?: HooksConfig;

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

  /**
   * Optional judge consulted when a tool that is not `dangerous` fails: if it
   * calls the error transient, the call is made once more, and the model sees
   * only the second result. Off by default. Never consulted for Bash, Write
   * or Edit, and never twice for one call.
   */
  retryJudge?: RetryJudge;

  /**
   * Optional judge consulted after every turn that made tool calls. When it
   * says stop, the run ends with `stopReason: "stuck"` and the verdict's
   * reason as its text; the session is saved as it would be after any other
   * ending. Off by default. A judge that fails means "keep going".
   */
  stopJudge?: StopJudge;
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
  /** Null when the model has no price in `utils/cost.ts`, rather than someone else's price. */
  estimatedCostUsd: number | null;
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
   * cut the run short, "aborted" when the caller's signal did, or "stuck"
   * when the stop judge ended it.
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
  | { type: "tool_retry"; toolUseId: string; toolName: string; error: string; verdict: RetryVerdict }
  /** The reply was cut off by max_tokens in the middle of a tool call; the turn is asked again with more room. */
  | { type: "turn_retry"; turn: number; reason: string; maxTokens: number }
  /** The history was replaced by a summary; `transcript` is where the full one was archived. */
  | { type: "compacted"; turn: number; promptTokens: number; transcript: string | undefined }
  /** The model rewrote its task list. */
  | { type: "todos"; todos: TodoItem[] }
  /** Something a subagent the Task tool started did, for a host that wants to show it. */
  | { type: "subagent"; subagent: string; event: AgentEvent }
  | { type: "stop_check"; turn: number; verdict: StopVerdict }
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
