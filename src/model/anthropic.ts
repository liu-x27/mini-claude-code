import Anthropic from "@anthropic-ai/sdk";
import type { ModelClient, ModelDelta, ModelRequest, ModelResponse } from "./types.js";

export interface AnthropicClientOptions {
  apiKey?: string | undefined;
  /** Any endpoint that speaks the Messages API, e.g. `https://api.minimaxi.com/anthropic`. */
  baseURL?: string | undefined;
}

/**
 * The Messages API, or anything compatible with it.
 *
 * Options left unset fall through to the SDK's own environment handling —
 * `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` — which is what lets the CLI run
 * against a compatible provider with no code change.
 */
export class AnthropicClient implements ModelClient {
  readonly name: string;
  private client: Anthropic;

  constructor(options: AnthropicClientOptions = {}) {
    this.client = new Anthropic({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
    this.name = options.baseURL ? `anthropic @ ${options.baseURL}` : "anthropic";
  }

  /**
   * Always streams on the wire, and forwards deltas only when asked to.
   *
   * The SDK refuses a non-streaming request whose max_tokens could take more
   * than ten minutes, and the loop raises max_tokens to retry a turn that was
   * cut off, so a non-streaming path would fail exactly when it is needed.
   */
  async create(
    request: ModelRequest,
    onDelta: (delta: ModelDelta) => Promise<void>,
  ): Promise<ModelResponse> {
    const options = request.signal ? { signal: request.signal } : undefined;
    const stream = this.client.messages.stream(buildParams(request), options);
    if (request.stream) {
      for await (const event of stream) {
        if (event.type !== "content_block_delta") continue;
        if (event.delta.type === "text_delta") {
          await onDelta({ type: "text", text: event.delta.text });
        } else if (event.delta.type === "thinking_delta") {
          await onDelta({ type: "thinking", thinking: event.delta.thinking });
        }
      }
    }
    const message = await stream.finalMessage();

    const u = message.usage;
    return {
      content: message.content,
      stopReason: message.stop_reason ?? "end_turn",
      usage: {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
      },
    };
  }
}

/**
 * The request body, without the transport. Exported so the mock suite can check it.
 *
 * With caching on there are two breakpoints: the system prompt, which caches
 * the tools rendered before it, and the last block of the conversation. The
 * second is what an agent loop lives on — each turn then reads everything
 * before it from cache and writes only what the last turn added. With only
 * the first, every turn paid full price for the whole history again.
 */
export function buildParams(request: ModelRequest): Anthropic.MessageCreateParamsNonStreaming {
  const tools = request.tools.map((t) => t.toAnthropicTool());
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.enableCaching
      ? [{ type: "text" as const, text: request.system, cache_control: { type: "ephemeral" as const } }]
      : request.system,
    messages: request.enableCaching ? withCacheBreakpoint(request.messages) : request.messages,
    thinking: request.thinking as Anthropic.ThinkingConfigParam,
    // Only when asked for: a default here would override the model's own and
    // be rejected by the models and compatible endpoints that do not take it.
    ...(request.effort ? { output_config: { effort: request.effort } } : {}),
    ...(tools.length > 0 && {
      tools,
      tool_choice: (request.toolChoice === "none" ? { type: "none" } : { type: "auto" }) as Anthropic.ToolChoice,
    }),
  };
}

/**
 * The messages with a cache breakpoint on the last block that can carry one.
 * A copy: the history itself is never marked, so the breakpoint moves forward
 * each turn instead of piling up past the limit of four.
 */
function withCacheBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  if (!last) return messages;
  const blocks: Anthropic.ContentBlockParam[] =
    typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (!block || block.type === "thinking" || block.type === "redacted_thinking") continue;
    blocks[i] = { ...block, cache_control: { type: "ephemeral" } } as Anthropic.ContentBlockParam;
    return [...messages.slice(0, -1), { ...last, content: blocks }];
  }
  return messages;
}
