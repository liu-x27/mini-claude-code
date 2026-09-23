import type Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { logger } from "../utils/logger.js";
import type { ModelClient, ModelDelta, ModelRequest, ModelResponse } from "./types.js";

export interface OpenAICompatibleClientOptions {
  apiKey?: string | undefined;
  /** e.g. `https://api.deepseek.com/v1`. Defaults to OpenAI's own. */
  baseURL?: string | undefined;
}

/**
 * Any Chat Completions endpoint: OpenAI, DeepSeek, Groq, OpenRouter, a local
 * Ollama.
 *
 * History arrives Anthropic-shaped and is converted on the way out by
 * `toOpenAIMessages`; the reply is converted back into content blocks on the
 * way in, so the agent loop never sees the difference. Always streams on the
 * wire — usage only arrives on the stream's last chunk — and forwards deltas
 * only when the request asked for them.
 *
 * `maxTokens` and `thinking` are not sent: the compatible endpoints disagree
 * on both, and the server this replaces never sent them either.
 */
export class OpenAICompatibleClient implements ModelClient {
  readonly name: string;
  private client: OpenAI;

  constructor(options: OpenAICompatibleClientOptions = {}) {
    this.client = new OpenAI({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
    this.name = `openai-compatible @ ${options.baseURL ?? "api.openai.com"}`;
  }

  async create(
    request: ModelRequest,
    onDelta: (delta: ModelDelta) => Promise<void>,
  ): Promise<ModelResponse> {
    const tools: OpenAI.Chat.ChatCompletionTool[] = request.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as unknown as Record<string, unknown>,
      },
    }));

    const stream = await this.client.chat.completions.create(
      {
        model: request.model,
        messages: toOpenAIMessages(request.system, request.messages),
        ...(tools.length > 0 && { tools, tool_choice: "auto" as const }),
        stream: true,
        stream_options: { include_usage: true },
      },
      request.signal ? { signal: request.signal } : undefined,
    );

    let text = "";
    let finishReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    const calls: Array<{ id: string; name: string; args: string }> = [];

    for await (const chunk of stream) {
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens;
        outputTokens = chunk.usage.completion_tokens;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta;
      if (delta.content) {
        text += delta.content;
        if (request.stream) await onDelta({ type: "text", text: delta.content });
      }
      for (const tc of delta.tool_calls ?? []) {
        const call = calls[tc.index] ?? { id: "", name: "", args: "" };
        calls[tc.index] = call;
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name = tc.function.name;
        if (tc.function?.arguments) call.args += tc.function.arguments;
      }
      finishReason = choice.finish_reason ?? finishReason;
    }

    const toolUses = calls.filter(Boolean).map(
      (call): Anthropic.ToolUseBlockParam => ({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: parseArguments(call),
      }),
    );

    return {
      content: [...(text ? [{ type: "text" as const, text }] : []), ...toolUses],
      // Keyed on the calls, not on finish_reason: several compatible
      // endpoints report "stop" on a reply that does carry tool calls.
      stopReason: toolUses.length > 0 ? "tool_use" : toStopReason(finishReason),
      usage: { inputTokens, outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0 },
    };
  }
}

/**
 * Anthropic-shaped history → Chat Completions messages.
 *
 * An assistant turn's tool_use blocks become `tool_calls`; a user turn's
 * tool_result blocks become one `tool` message each, in order; thinking
 * blocks are dropped, since no compatible endpoint takes them back.
 */
export function toOpenAIMessages(
  system: string,
  messages: Anthropic.MessageParam[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: system }];

  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    if (m.role === "assistant") {
      const text = m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const toolUses = m.content.filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use");
      out.push(
        toolUses.length > 0
          ? {
              role: "assistant",
              content: text || null,
              tool_calls: toolUses.map((b) => ({
                id: b.id,
                type: "function" as const,
                function: { name: b.name, arguments: JSON.stringify(b.input) },
              })),
            }
          : { role: "assistant", content: text },
      );
      continue;
    }

    const userText: string[] = [];
    for (const block of m.content as unknown as LooseBlock[]) {
      if (isToolResult(block)) {
        out.push({ role: "tool", tool_call_id: block.tool_use_id, content: resultText(block.content) });
      } else if (block.type === "text" && typeof block.text === "string") {
        userText.push(block.text);
      }
    }
    if (userText.length > 0) out.push({ role: "user", content: userText.join("\n") });
  }

  return out;
}

type LooseBlock = { type?: string; text?: unknown; tool_use_id?: unknown; content?: unknown };

/**
 * Also accepts `{ tool_use_id, content }` with no `type`: the web server used
 * to store tool results that way on this path, and sessions written by it
 * are still on disk.
 */
function isToolResult(block: LooseBlock): block is LooseBlock & { tool_use_id: string } {
  return (
    typeof block.tool_use_id === "string" && (block.type === "tool_result" || block.type === undefined)
  );
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: LooseBlock) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
      .join("");
  }
  return "";
}

function parseArguments(call: { name: string; args: string }): Record<string, unknown> {
  if (!call.args) return {};
  try {
    return JSON.parse(call.args) as Record<string, unknown>;
  } catch {
    // Run it with no input rather than drop it: the tool's own validation
    // then reports the problem back to the model, which can retry.
    logger.warn(`${call.name}: arguments were not valid JSON — ${call.args.slice(0, 80)}`);
    return {};
  }
}

function toStopReason(finishReason: string | null): string {
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return "end_turn";
  }
}
