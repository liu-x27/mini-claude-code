import Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";
import { PermissionSystem } from "./permissions/index.js";
import { SessionManager } from "./session/manager.js";
import type { Tool } from "./tools/base.js";
import { globalRegistry, registerBuiltinTools } from "./tools/index.js";
import type { ToolRegistry } from "./tools/registry.js";
import type {
  AgentConfig,
  AgentEvent,
  AgentEventHandler,
  AgentResult,
  AgentUsage,
  ConversationMessage,
  ToolCallRecord,
  ToolContext,
} from "./types.js";
import { estimateCost } from "./utils/cost.js";
import { logger } from "./utils/logger.js";

// Ensure built-in tools are registered
registerBuiltinTools();

const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_TOKENS = 16_000;

const BASE_SYSTEM_PROMPT = `You are a helpful, capable AI assistant with access to tools.
You can read and write files, run shell commands, search the web, and more.
Always think step by step. When using tools, be precise and efficient.
If a task requires multiple steps, plan them out before executing.`;

/**
 * The core Agent class.
 *
 * Wraps Claude's API in an agentic loop:
 * 1. Send user prompt
 * 2. If Claude calls tools → execute them → feed results back
 * 3. Repeat until Claude returns end_turn or max turns reached
 *
 * @example
 * ```ts
 * const agent = new Agent({ model: "claude-opus-5" });
 * const result = await agent.run("What files are in /tmp?");
 * console.log(result.text);
 * ```
 */
export class Agent {
  private client: Anthropic;
  private config: Required<AgentConfig>;
  private registry: ToolRegistry;
  private permissions: PermissionSystem;
  private sessions: SessionManager;
  private eventHandlers: AgentEventHandler[] = [];

  constructor(config: AgentConfig = {}, registry?: ToolRegistry) {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    this.config = {
      model: config.model ?? (process.env.AGENT_MODEL as AgentConfig["model"]) ?? DEFAULT_MODEL,
      systemPrompt: config.systemPrompt ?? "",
      cwd: config.cwd ?? process.cwd(),
      maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
      maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      thinking: config.thinking ?? { type: "adaptive" },
      effort: config.effort ?? "high",
      allowedTools: config.allowedTools ?? [],
      disallowedTools: config.disallowedTools ?? [],
      permissions: config.permissions ?? {},
      resumeSessionId: config.resumeSessionId ?? "",
      persistSessions: config.persistSessions ?? true,
      sessionDir: config.sessionDir ?? "",
      subagents: config.subagents ?? {},
      enableCaching: config.enableCaching ?? true,
      stream: config.stream ?? false,
    };

    this.registry = registry ?? globalRegistry;
    this.permissions = new PermissionSystem(this.config.permissions);
    this.sessions = new SessionManager(this.config.sessionDir || undefined);
  }

  /** Register an event handler for streaming output and lifecycle events */
  on(handler: AgentEventHandler): this {
    this.eventHandlers.push(handler);
    return this;
  }

  /** Remove an event handler */
  off(handler: AgentEventHandler): this {
    this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
    return this;
  }

  /**
   * Run the agent with a prompt.
   * Executes the full agentic loop and returns when done.
   */
  async run(prompt: string): Promise<AgentResult> {
    const tools = this.resolveTools();
    const session = await this.initSession();

    const messages: ConversationMessage[] = [...session.messages];
    messages.push({ role: "user", content: prompt });

    const toolCalls: ToolCallRecord[] = [];
    const usageAccum: AgentUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      estimatedCostUsd: 0,
    };

    let turn = 0;
    let finalText = "";
    let finalStopReason = "end_turn";

    while (turn < this.config.maxTurns) {
      turn++;
      await this.emit({ type: "turn_start", turn });

      // Build API params
      const apiMessages = this.buildApiMessages(messages);
      const systemPrompt = this.buildSystemPrompt();

      let response: Anthropic.Message;

      if (this.config.stream) {
        response = await this.callApiStreaming(apiMessages, systemPrompt, tools);
      } else {
        response = await this.callApi(apiMessages, systemPrompt, tools);
      }

      // Accumulate usage
      const turnUsage = this.accumulateUsage(response, usageAccum);
      await this.emit({ type: "turn_end", turn, usage: turnUsage });

      // Append assistant message to history
      messages.push({ role: "assistant", content: response.content });

      finalStopReason = response.stop_reason ?? "end_turn";

      // If no tool calls, we're done
      if (response.stop_reason === "end_turn") {
        finalText = this.extractText(response.content);
        break;
      }

      // Handle tool_use
      if (response.stop_reason === "tool_use") {
        const toolUseBlocks = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );

        const toolResults = await this.executeTools(toolUseBlocks, toolCalls, {
          cwd: this.config.cwd,
          sessionId: session.metadata.sessionId,
          agentId: "main",
          permissions: this.permissions.getContext(),
        });

        // Append tool results as user message
        messages.push({ role: "user", content: toolResults });
        continue;
      }

      // Any other stop reason
      finalText = this.extractText(response.content);
      break;
    }

    if (turn >= this.config.maxTurns) {
      logger.warn(`Max turns (${this.config.maxTurns}) reached`);
      finalStopReason = "max_turns";
    }

    // Persist session
    if (this.config.persistSessions) {
      const updatedSession = this.sessions.appendMessages(
        session,
        messages.slice(session.messages.length),
      );
      const finalSession = await this.sessions.updateMetadata(updatedSession, {
        turns: session.metadata.turns + turn,
        totalInputTokens: session.metadata.totalInputTokens + usageAccum.inputTokens,
        totalOutputTokens: session.metadata.totalOutputTokens + usageAccum.outputTokens,
        totalCost: session.metadata.totalCost + usageAccum.estimatedCostUsd,
      });
      await this.sessions.save(finalSession);
    }

    const result: AgentResult = {
      text: finalText,
      stopReason: finalStopReason,
      turns: turn,
      toolCalls,
      usage: usageAccum,
      sessionId: session.metadata.sessionId,
    };

    await this.emit({ type: "done", result });
    return result;
  }

  /**
   * Run the agent with streaming output to stdout.
   * Convenience wrapper around `run()` with a default stream handler.
   */
  async runWithOutput(prompt: string): Promise<AgentResult> {
    this.on(async (event) => {
      if (event.type === "text_delta") {
        process.stdout.write(event.delta);
      } else if (event.type === "thinking_delta") {
        process.stdout.write(chalk.magenta(event.delta));
      } else if (event.type === "tool_start") {
        logger.tool(event.toolName, JSON.stringify(event.input).slice(0, 80));
      } else if (event.type === "done") {
        const u = event.result.usage;
        console.log(
          chalk.gray(
            `\n\n[${event.result.turns} turn(s), ${u.inputTokens + u.outputTokens} tokens, $${u.estimatedCostUsd.toFixed(5)}]`,
          ),
        );
      }
    });

    const config = { ...this.config, stream: true };
    this.config = config as Required<AgentConfig>;
    return this.run(prompt);
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

  private async callApi(
    messages: Anthropic.MessageParam[],
    system: string,
    tools: Tool[],
  ): Promise<Anthropic.Message> {
    const anthropicTools = tools.map((t) => t.toAnthropicTool());

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      system: this.config.enableCaching
        ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
        : system,
      messages,
      thinking: this.config.thinking as Anthropic.ThinkingConfigParam,
      ...(anthropicTools.length > 0 && {
        tools: anthropicTools,
        tool_choice: { type: "auto" } as Anthropic.ToolChoiceAuto,
      }),
    };

    return this.client.messages.create(params);
  }

  private async callApiStreaming(
    messages: Anthropic.MessageParam[],
    system: string,
    tools: Tool[],
  ): Promise<Anthropic.Message> {
    const anthropicTools = tools.map((t) => t.toAnthropicTool());

    const params: Anthropic.MessageCreateParamsStreaming = {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      system: this.config.enableCaching
        ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
        : system,
      messages,
      thinking: this.config.thinking as Anthropic.ThinkingConfigParam,
      ...(anthropicTools.length > 0 && {
        tools: anthropicTools,
        tool_choice: { type: "auto" } as Anthropic.ToolChoiceAuto,
      }),
      stream: true,
    };

    let finalMessage: Anthropic.Message | null = null;

    const stream = this.client.messages.stream(params);

    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          await this.emit({ type: "text_delta", delta: event.delta.text });
        } else if (event.delta.type === "thinking_delta") {
          await this.emit({ type: "thinking_delta", delta: event.delta.thinking });
        }
      }
    }

    finalMessage = await stream.finalMessage();
    return finalMessage;
  }

  private async executeTools(
    toolUseBlocks: Anthropic.ToolUseBlock[],
    toolCallRecords: ToolCallRecord[],
    context: ToolContext,
  ): Promise<Anthropic.ToolResultBlockParam[]> {
    const results: Anthropic.ToolResultBlockParam[] = [];

    // Execute tools (concurrently within limit)
    const maxConcurrent = Number(process.env.AGENT_MAX_CONCURRENT_TOOLS ?? 4);
    const batches = chunk(toolUseBlocks, maxConcurrent);

    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map(async (block) => {
          const tool = this.registry.get(block.name);

          if (!tool) {
            logger.warn(`Unknown tool: ${block.name}`);
            return {
              type: "tool_result" as const,
              tool_use_id: block.id,
              content: `Error: Tool "${block.name}" is not registered.`,
              is_error: true,
            };
          }

          const input = block.input as Record<string, unknown>;

          // Permission check
          const allowed = await this.permissions.check({
            toolName: tool.name,
            input,
            description: tool.summarize(input),
          });

          if (!allowed) {
            return {
              type: "tool_result" as const,
              tool_use_id: block.id,
              content: `Permission denied for tool: ${tool.name}`,
              is_error: true,
            };
          }

          await this.emit({ type: "tool_start", toolName: tool.name, input });

          const start = Date.now();
          const toolResult = await tool.execute(input, context);
          const durationMs = Date.now() - start;

          toolCallRecords.push({ toolName: tool.name, input, result: toolResult, durationMs });
          await this.emit({
            type: "tool_end",
            toolName: tool.name,
            result: toolResult,
            durationMs,
          });

          const content =
            toolResult.type === "success" ? toolResult.output : `Error: ${toolResult.message}`;

          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content,
            is_error: toolResult.type === "error",
          };
        }),
      );

      results.push(...batchResults);
    }

    return results;
  }

  private resolveTools(): Tool[] {
    return this.registry.resolve(
      this.config.allowedTools.length > 0 ? this.config.allowedTools : undefined,
      this.config.disallowedTools.length > 0 ? this.config.disallowedTools : undefined,
    );
  }

  private buildSystemPrompt(): string {
    const parts = [BASE_SYSTEM_PROMPT];
    if (this.config.systemPrompt) parts.push(this.config.systemPrompt);
    parts.push(`\nCurrent working directory: ${this.config.cwd}`);
    parts.push(`Current date: ${new Date().toISOString().slice(0, 10)}`);
    return parts.join("\n\n");
  }

  private buildApiMessages(messages: ConversationMessage[]): Anthropic.MessageParam[] {
    return messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
  }

  private extractText(content: Anthropic.ContentBlock[]): string {
    return content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  private accumulateUsage(response: Anthropic.Message, accum: AgentUsage): AgentUsage {
    const u = response.usage as Anthropic.Usage & {
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };

    const inputTokens = u.input_tokens ?? 0;
    const outputTokens = u.output_tokens ?? 0;
    const cacheCreation = u.cache_creation_input_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;

    const cost = estimateCost(
      this.config.model,
      inputTokens,
      outputTokens,
      cacheCreation,
      cacheRead,
    );

    accum.inputTokens += inputTokens;
    accum.outputTokens += outputTokens;
    accum.cacheCreationTokens += cacheCreation;
    accum.cacheReadTokens += cacheRead;
    accum.estimatedCostUsd += cost;

    return {
      inputTokens,
      outputTokens,
      cacheCreationTokens: cacheCreation,
      cacheReadTokens: cacheRead,
      estimatedCostUsd: cost,
    };
  }

  private async initSession() {
    if (this.config.resumeSessionId) {
      const existing = await this.sessions.load(this.config.resumeSessionId);
      if (existing) {
        logger.info(`Resuming session: ${this.config.resumeSessionId}`);
        return existing;
      }
      logger.warn(`Session not found: ${this.config.resumeSessionId}. Starting new session.`);
    }

    return this.sessions.create({
      model: this.config.model,
      cwd: this.config.cwd,
      turns: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
    });
  }

  private async emit(event: AgentEvent): Promise<void> {
    await Promise.all(this.eventHandlers.map((h) => h(event)));
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
