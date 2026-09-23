import type Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";
import { AnthropicClient } from "./model/anthropic.js";
import type { ModelClient, ModelDelta, ModelResponse } from "./model/types.js";
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
  ModelRouter,
  RetryJudge,
  RunOptions,
  StopJudge,
  ToolCallRecord,
  ToolContext,
  ToolResult,
  TracedCall,
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
 * Wraps a model API in an agentic loop:
 * 1. Send user prompt
 * 2. If the model calls tools → execute them → feed results back
 * 3. Repeat until the model stops asking for tools or max turns is reached
 *
 * @example
 * ```ts
 * const agent = new Agent({ model: "claude-opus-5" });
 * const result = await agent.run("What files are in /tmp?");
 * console.log(result.text);
 * ```
 */
export class Agent {
  private client: ModelClient;
  /**
   * Everything with a default. The judges, `router` and `client` are deliberately not in
   * here: neither has a sensible sentinel the way "" serves for
   * resumeSessionId, and Required<> under exactOptionalPropertyTypes cannot
   * hold an absent value.
   */
  private config: Required<Omit<AgentConfig, "router" | "client" | "retryJudge" | "stopJudge">>;
  private registry: ToolRegistry;
  private permissions: PermissionSystem;
  private sessions: SessionManager;
  private eventHandlers: AgentEventHandler[] = [];
  private router: ModelRouter | undefined;
  private retryJudge: RetryJudge | undefined;
  private stopJudge: StopJudge | undefined;

  constructor(config: AgentConfig = {}, registry?: ToolRegistry) {
    this.client = config.client ?? new AnthropicClient();

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

    this.router = config.router;
    this.retryJudge = config.retryJudge;
    this.stopJudge = config.stopJudge;

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
  async run(prompt: string, options: RunOptions = {}): Promise<AgentResult> {
    const { signal } = options;
    const tools = this.resolveTools();
    const session = await this.initSession();
    await this.emit({
      type: "session",
      sessionId: session.metadata.sessionId,
      resumed: session.messages.length > 0,
    });
    await this.route(prompt);

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
    // Only a `break` below overwrites this. Leaving the loop through its own
    // condition means the last turn still asked for tools, so the limit —
    // not the model — ended the run. Checking `turn >= maxTurns` afterwards
    // instead would also flag a run that finished cleanly on its last turn.
    let finalStopReason = "max_turns";

    while (turn < this.config.maxTurns) {
      if (signal?.aborted) {
        finalStopReason = "aborted";
        break;
      }
      turn++;
      await this.emit({ type: "turn_start", turn });

      let response: ModelResponse;
      try {
        response = await this.client.create(
          {
            model: this.config.model,
            system: this.buildSystemPrompt(),
            messages: this.buildApiMessages(messages),
            tools,
            maxTokens: this.config.maxTokens,
            thinking: this.config.thinking,
            enableCaching: this.config.enableCaching,
            stream: this.config.stream,
            signal,
          },
          (delta) => this.emitDelta(delta),
        );
      } catch (err) {
        if (signal?.aborted) {
          finalStopReason = "aborted";
          break;
        }
        throw err;
      }

      // Accumulate usage
      const turnUsage = this.accumulateUsage(response, usageAccum);
      await this.emit({ type: "turn_end", turn, usage: turnUsage });

      // Append assistant message to history
      messages.push({ role: "assistant", content: response.content });

      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use",
      );

      if (response.stopReason === "tool_use" && toolUseBlocks.length > 0) {
        const toolResults = await this.executeTools(
          toolUseBlocks,
          toolCalls,
          {
            cwd: this.config.cwd,
            sessionId: session.metadata.sessionId,
            agentId: "main",
            permissions: this.permissions.getContext(),
          },
          signal,
        );

        // Append tool results as user message
        messages.push({ role: "user", content: toolResults });

        // Every tool_use has its result by now, so stopping here leaves a
        // transcript that resumes like any other.
        if (this.stopJudge && !signal?.aborted) {
          const verdict = await settle(
            () => this.stopJudge!({ prompt, turn, recent: this.trace(toolCalls) }),
            (reason) => ({ stop: false, probability: undefined, reason }),
          );
          await this.emit({ type: "stop_check", turn, verdict });
          if (verdict.stop) {
            finalStopReason = "stuck";
            finalText = `Stopped: ${verdict.reason}.`;
            break;
          }
        }
        continue;
      }

      // end_turn, or any other stop reason
      finalStopReason = response.stopReason;
      finalText = this.extractText(response.content);
      break;
    }

    if (finalStopReason === "max_turns") {
      logger.warn(`Max turns (${this.config.maxTurns}) reached`);
    }

    // Persist session. Also after an abort: every assistant tool_use already
    // has its tool_result by now, so the transcript is valid to resume from.
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

    this.config = { ...this.config, stream: true };
    return this.run(prompt);
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

  private async executeTools(
    toolUseBlocks: Anthropic.ToolUseBlockParam[],
    toolCallRecords: ToolCallRecord[],
    context: ToolContext,
    signal: AbortSignal | undefined,
  ): Promise<Anthropic.ToolResultBlockParam[]> {
    const results: Anthropic.ToolResultBlockParam[] = [];

    // Execute tools (concurrently within limit)
    const maxConcurrent = Number(process.env.AGENT_MAX_CONCURRENT_TOOLS ?? 4);
    const batches = chunk(toolUseBlocks, maxConcurrent);

    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map((block) => this.executeTool(block, toolCallRecords, context, signal)),
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * One tool call, start to finish. Never rejects: every way a call can fail
   * becomes an error result for the model, because a rejection here would
   * take down the whole batch and lose the turn.
   */
  private async executeTool(
    block: Anthropic.ToolUseBlockParam,
    toolCallRecords: ToolCallRecord[],
    context: ToolContext,
    signal: AbortSignal | undefined,
  ): Promise<Anthropic.ToolResultBlockParam> {
    const toolUseId = block.id;
    const input = block.input as Record<string, unknown>;
    await this.emit({ type: "tool_request", toolUseId, toolName: block.name, input });

    const refuse = async (reason: string, content: string) => {
      await this.emit({ type: "tool_denied", toolUseId, toolName: block.name, reason });
      return { type: "tool_result" as const, tool_use_id: toolUseId, content, is_error: true };
    };

    const tool = this.registry.get(block.name);
    if (!tool) {
      logger.warn(`Unknown tool: ${block.name}`);
      return refuse("not registered", `Error: Tool "${block.name}" is not registered.`);
    }

    // Permission check
    const allowed = await this.permissions.check({
      toolName: tool.name,
      input,
      description: tool.summarize(input),
      toolUseId,
    });
    if (!allowed) {
      return refuse("permission denied", `Permission denied for tool: ${tool.name}`);
    }
    // An approval can take minutes; the run may have been stopped meanwhile.
    if (signal?.aborted) {
      return refuse("cancelled", "Cancelled: the run was stopped before this call started.");
    }

    await this.emit({ type: "tool_start", toolUseId, toolName: tool.name, input });

    const start = Date.now();
    const attempt = async (): Promise<ToolResult> => {
      try {
        return await tool.execute(input, context);
      } catch (err) {
        return { type: "error", message: `${tool.name} threw: ${err instanceof Error ? err.message : String(err)}` };
      }
    };
    let toolResult = await attempt();

    // One more try for a call that changes nothing, if the judge calls the
    // failure transient. Never for a dangerous tool, never twice.
    if (toolResult.type === "error" && !tool.dangerous && this.retryJudge && !signal?.aborted) {
      const error = toolResult.message;
      const verdict = await settle(
        () => this.retryJudge!({ toolName: tool.name, summary: tool.summarize(input), error }),
        (reason) => ({ retry: false, probability: undefined, reason }),
      );
      await this.emit({ type: "tool_retry", toolUseId, toolName: tool.name, error, verdict });
      if (verdict.retry && !signal?.aborted) toolResult = await attempt();
    }
    const durationMs = Date.now() - start;

    toolCallRecords.push({ toolName: tool.name, input, result: toolResult, durationMs });
    await this.emit({ type: "tool_end", toolUseId, toolName: tool.name, result: toolResult, durationMs });

    return {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: toolResult.type === "success" ? toolResult.output : `Error: ${toolResult.message}`,
      is_error: toolResult.type === "error",
    };
  }

  /** The last few calls, as the stop judge sees them. */
  private trace(records: ToolCallRecord[]): TracedCall[] {
    return records.slice(-8).map((r) => {
      const tool = this.registry.get(r.toolName);
      const ok = r.result.type === "success";
      const text = r.result.type === "success" ? r.result.output : r.result.message;
      return {
        tool: r.toolName,
        input: r.input,
        summary: tool ? `${r.toolName}(${tool.summarize(r.input)})` : r.toolName,
        ok,
        outcome: text.replace(/\s+/g, " ").trim().slice(0, 200),
      };
    });
  }

  /**
   * Let the router pick the model for this run, if one is configured.
   *
   * Mutates `config.model` rather than threading a per-call model through
   * every API path, because the decision is made once per run and every call
   * in that run should agree with it. It emits nothing: the routing event
   * belongs to whatever installed the router, and the CLI logs it there.
   */
  private async route(prompt: string): Promise<void> {
    if (!this.router) return;

    const verdict = await this.router(prompt);
    if (verdict.model !== this.config.model) {
      logger.debug(
        `Router chose ${verdict.model} over ${this.config.model} — ${verdict.reason}`,
      );
    }
    this.config.model = verdict.model;
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

  private extractText(content: Anthropic.ContentBlockParam[]): string {
    return content
      .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  private accumulateUsage(response: ModelResponse, accum: AgentUsage): AgentUsage {
    const { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens } = response.usage;

    const cost = estimateCost(
      this.config.model,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
    );

    accum.inputTokens += inputTokens;
    accum.outputTokens += outputTokens;
    accum.cacheCreationTokens += cacheCreationTokens;
    accum.cacheReadTokens += cacheReadTokens;
    accum.estimatedCostUsd += cost;

    return { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, estimatedCostUsd: cost };
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

  private emitDelta(delta: ModelDelta): Promise<void> {
    return delta.type === "text"
      ? this.emit({ type: "text_delta", delta: delta.text })
      : this.emit({ type: "thinking_delta", delta: delta.thinking });
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

/**
 * A judge's verdict, or `fallback` if the judge throws. The judges shipped in
 * src/judge never throw, but a caller's own can, and a judge that fails has
 * to mean "carry on as if there were no judge" — not take the run down.
 */
async function settle<T>(judge: () => Promise<T>, fallback: (reason: string) => T): Promise<T> {
  try {
    return await judge();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Judge failed, carrying on without it: ${message}`);
    return fallback(`judge failed: ${message}`);
  }
}
