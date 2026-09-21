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
  createRiskGate,
  RISK_QUESTIONS,
  UNKNOWN_PROBABILITY,
} from "./judge/index.js";
export type {
  JudgeBackend,
  JudgeCapability,
  JudgeState,
  LlmJudgeOptions,
  NoulAnswer,
  NoulQuestion,
  RiskGateOptions,
} from "./judge/index.js";

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
  Session,
  SessionMetadata,
  ConversationMessage,
  SubagentDefinition,
  ThinkingConfig,
  EffortLevel,
  ToolCallRecord,
} from "./types.js";
