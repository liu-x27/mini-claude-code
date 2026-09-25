/**
 * agent-app — A production-grade, extensible Agent framework powered by Claude
 *
 * @example
 * ```ts
 * import { Agent } from "agent-app";
 *
 * const agent = new Agent({
 *   model: "claude-opus-5",
 *   allowedTools: ["Read", "Glob", "Grep"],
 * });
 *
 * const result = await agent.run("Explain what this codebase does");
 * console.log(result.text);
 * ```
 */

// Core
export { Agent } from "./agent.js";

// Model APIs — what the agent loop calls
export { AnthropicClient, OpenAICompatibleClient, toOpenAIMessages } from "./model/index.js";
export type {
  AnthropicClientOptions,
  ModelClient,
  ModelDelta,
  ModelRequest,
  ModelResponse,
  OpenAICompatibleClientOptions,
} from "./model/index.js";

// Tools
export { Tool } from "./tools/base.js";
export { ToolRegistry, globalRegistry } from "./tools/registry.js";
export { registerBuiltinTools } from "./tools/index.js";
export { BashTool } from "./tools/bash.js";
export { FileReadTool } from "./tools/file-read.js";
export { FileWriteTool } from "./tools/file-write.js";
export { FileEditTool } from "./tools/file-edit.js";
export { GlobTool } from "./tools/glob.js";
export { GrepTool } from "./tools/grep.js";
export { WebFetchTool } from "./tools/web-fetch.js";

// Session
export { SessionManager } from "./session/manager.js";

// Permissions
export {
  PermissionSystem,
  PermissionPresets,
  stdinPrompt,
  parseDecision,
} from "./permissions/index.js";

// Judge — the decision layer in front of the permission prompt
export {
  AllowlistJudge,
  LlmJudge,
  createModelRouter,
  createRiskGate,
  RISK_QUESTIONS,
  ROUTING_QUESTION,
  UNKNOWN_PROBABILITY,
} from "xavierjev";
export type {
  JudgeBackend,
  JudgeCapability,
  JudgeState,
  LlmJudgeOptions,
  ModelRouterOptions,
  NoulAnswer,
  NoulQuestion,
  RiskGateOptions,
} from "xavierjev";

// Utils
export { logger } from "./utils/logger.js";
export { estimateCost, formatCost } from "./utils/cost.js";

// Types
export type {
  AgentConfig,
  AgentResult,
  AgentEvent,
  AgentEventHandler,
  AgentUsage,
  RunOptions,
  ModelId,
  ToolResult,
  ToolContext,
  ToolInputSchema,
  PermissionContext,
  PermissionMode,
  PermissionRule,
  PermissionPrompt,
  PermissionDecision,
  PermissionRequest,
  RiskGate,
  GateVerdict,
  ModelRouter,
  RouteVerdict,
  Session,
  SessionMetadata,
  ConversationMessage,
  SubagentDefinition,
  ThinkingConfig,
  EffortLevel,
  ToolCallRecord,
} from "./types.js";
