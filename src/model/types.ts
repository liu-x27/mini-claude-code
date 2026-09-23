import type Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "../tools/base.js";
import type { ModelId, ThinkingConfig } from "../types.js";

/**
 * One call to a model, in the shape the agent loop keeps its history in.
 *
 * History is always Anthropic-shaped — content blocks, tool_use / tool_result
 * pairs — because that is what the loop reasons about. A client for another
 * API converts at its own edge, on the way out and on the way back, so the
 * loop never branches on provider.
 */
export interface ModelRequest {
  model: ModelId;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Tool[];
  maxTokens: number;
  thinking: ThinkingConfig;
  enableCaching: boolean;
  /** Report deltas as they arrive, rather than only returning the finished message. */
  stream: boolean;
  signal?: AbortSignal | undefined;
}

export type ModelDelta = { type: "text"; text: string } | { type: "thinking"; thinking: string };

export interface ModelResponse {
  /** Blocks to append to history as they are, thinking signatures included. */
  content: Anthropic.ContentBlockParam[];
  /** In Anthropic's vocabulary whatever the API: "end_turn", "tool_use", "max_tokens", … */
  stopReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
}

/**
 * What the agent loop needs from a model API, and nothing else.
 *
 * Injectable for two reasons. The web server takes the key, base URL and API
 * format per request, from the browser, so it cannot rely on process-wide
 * environment variables the way the CLI does. And the loop itself — turn
 * limits, tool execution, cancellation — can be tested against a scripted
 * client, with no key and no network.
 */
export interface ModelClient {
  /** For logs and the startup banner. */
  readonly name: string;
  create(request: ModelRequest, onDelta: (delta: ModelDelta) => Promise<void>): Promise<ModelResponse>;
}
