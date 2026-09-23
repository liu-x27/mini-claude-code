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

  async create(
    request: ModelRequest,
    onDelta: (delta: ModelDelta) => Promise<void>,
  ): Promise<ModelResponse> {
    const tools = request.tools.map((t) => t.toAnthropicTool());
    const params = {
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.enableCaching
        ? [{ type: "text" as const, text: request.system, cache_control: { type: "ephemeral" as const } }]
        : request.system,
      messages: request.messages,
      thinking: request.thinking as Anthropic.ThinkingConfigParam,
      ...(tools.length > 0 && {
        tools,
        tool_choice: { type: "auto" } as Anthropic.ToolChoiceAuto,
      }),
    };
    const options = request.signal ? { signal: request.signal } : undefined;

    let message: Anthropic.Message;
    if (request.stream) {
      const stream = this.client.messages.stream(params, options);
      for await (const event of stream) {
        if (event.type !== "content_block_delta") continue;
        if (event.delta.type === "text_delta") {
          await onDelta({ type: "text", text: event.delta.text });
        } else if (event.delta.type === "thinking_delta") {
          await onDelta({ type: "thinking", thinking: event.delta.thinking });
        }
      }
      message = await stream.finalMessage();
    } else {
      message = await this.client.messages.create({ ...params, stream: false }, options);
    }

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
