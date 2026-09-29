import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";
import { loadProjectInstructions } from "./context/instructions.js";
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
  EffortLevel,
  ModelRouter,
  RetryJudge,
  RunOptions,
  Session,
  SessionMetadata,
  StopJudge,
  ToolCallRecord,
  ToolContext,
  ToolResult,
  TracedCall,
} from "./types.js";
import { addCost, estimateCost, formatCost } from "./utils/cost.js";
import { logger } from "./utils/logger.js";
import { MAX_TOOL_OUTPUT_CHARS, truncateMiddle } from "./utils/truncate.js";

// Ensure built-in tools are registered
registerBuiltinTools();

const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_TOKENS = 16_000;
/** How far a turn cut off mid tool call may raise max_tokens, doubling each time. */
const MAX_RETRY_TOKENS = 64_000;

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
   * Everything with a default. The judges, `router`, `client` and `effort`
   * are deliberately not in here: none has a sensible sentinel the way ""
   * serves for resumeSessionId, and Required<> under
   * exactOptionalPropertyTypes cannot hold an absent value.
   */
  private config: Required<Omit<AgentConfig, "router" | "client" | "retryJudge" | "stopJudge" | "effort">>;
  private registry: ToolRegistry;
  private permissions: PermissionSystem;
  private sessions: SessionManager;
  private eventHandlers: AgentEventHandler[] = [];
  private router: ModelRouter | undefined;
  private retryJudge: RetryJudge | undefined;
  private stopJudge: StopJudge | undefined;
  private effort: EffortLevel | undefined;

  constructor(config: AgentConfig = {}, registry?: ToolRegistry) {
    this.client = config.client ?? new AnthropicClient();

    this.config = {
      model: config.model ?? (process.env.AGENT_MODEL as AgentConfig["model"]) ?? DEFAULT_MODEL,
      systemPrompt: config.systemPrompt ?? "",
      cwd: config.cwd ?? process.cwd(),
      maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
      maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      thinking: config.thinking ?? { type: "adaptive" },
      allowedTools: config.allowedTools ?? [],
      disallowedTools: config.disallowedTools ?? [],
      permissions: config.permissions ?? {},
      resumeSessionId: config.resumeSessionId ?? "",
      persistSessions: config.persistSessions ?? true,
      sessionDir: config.sessionDir ?? "",
      subagents: config.subagents ?? {},
      enableCaching: config.enableCaching ?? true,
      projectInstructions: config.projectInstructions ?? true,
      stream: config.stream ?? false,
    };

    this.router = config.router;
    this.retryJudge = config.retryJudge;
    this.stopJudge = config.stopJudge;
    this.effort = config.effort;

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
    const notes: string[] = [];
    if (session.messages.length === 0 && this.config.projectInstructions) {
      const instructions = await loadProjectInstructions(this.config.cwd);
      if (instructions) notes.push(instructions);
    }
    const environment = this.environmentLine();
    if (session.metadata.environment !== environment) notes.push(`[Environment: ${environment}]`);
    if (session.metadata.interrupted) {
      notes.push(
        `[Note from the harness: the previous run in this session ended early — ${session.metadata.interrupted}. The history above is what was recorded; check the current state before relying on its last step.]`,
      );
    }
    session.metadata.environment = environment;
    messages.push({ role: "user", content: userTurn(prompt, notes) });

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

    // Saved after every turn rather than once at the end. A run whose model
    // call failed on turn five used to leave no session at all, while the
    // tool calls of turns one to four had already changed the disk.
    const save = (interrupted?: string) => this.persist(session, messages, turn, usageAccum, interrupted);

    try {
      while (turn < this.config.maxTurns) {
        if (signal?.aborted) {
          finalStopReason = "aborted";
          break;
        }
        turn++;
        await this.emit({ type: "turn_start", turn });

        const called = await this.callModel(turn, messages, tools, signal, usageAccum);
        if (!called) {
          finalStopReason = "aborted";
          break;
        }
        const { response, maxTokens } = called;

        const toolUseBlocks = response.content.filter(
          (b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use",
        );

        if (response.stopReason === "tool_use" && toolUseBlocks.length > 0) {
          // If the process dies while these run, the next run can say which
          // calls were in flight: the saved history stops before this turn,
          // and the note names what it was doing.
          await save(`the process stopped while these tool calls were running: ${this.describeCalls(toolUseBlocks)}`);

          messages.push({ role: "assistant", content: response.content });
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
          await save();

          // Every tool_use has its result by now, so stopping here leaves a
          // transcript that resumes like any other.
          const stopJudge = this.stopJudge;
          if (stopJudge && !signal?.aborted) {
            const verdict = await settle(
              () => stopJudge({ prompt, turn, recent: this.trace(toolCalls) }),
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

        const text = this.extractText(response.content);
        const notice = stopNotice(response.stopReason, maxTokens);

        if (toolUseBlocks.length > 0) {
          // It asked for tools and then stopped for another reason: cut off by
          // max_tokens or the context window, or a refusal. That tool_use can
          // never get its result, and a history holding one is refused on
          // every later request, so the reply is dropped rather than saved
          // and nothing it asked for runs.
          finalStopReason = response.stopReason;
          finalText = [text, notice, "It was in the middle of a tool call: nothing was run, and the partial reply was not saved."]
            .filter(Boolean)
            .join("\n\n");
          break;
        }

        // end_turn, or any other stop reason
        messages.push({ role: "assistant", content: response.content });
        finalStopReason = response.stopReason;
        finalText = text || notice || "";
        break;
      }
    } catch (err) {
      const reason = `the run failed (${err instanceof Error ? err.message : String(err)})`;
      const last = messages[messages.length - 1];
      const inFlight =
        last?.role === "assistant" && Array.isArray(last.content)
          ? last.content.filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use")
          : [];
      await save(inFlight.length > 0 ? `${reason} while these tool calls were running: ${this.describeCalls(inFlight)}` : reason);
      throw err;
    }

    if (finalStopReason === "max_turns") {
      logger.warn(`Max turns (${this.config.maxTurns}) reached`);
    }

    // Also after an abort: every assistant tool_use already has its
    // tool_result by now, so the transcript is valid to resume from.
    await save(finalStopReason === "aborted" ? "it was stopped before it finished" : undefined);

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
            `\n\n[${event.result.turns} turn(s), ${u.inputTokens + u.outputTokens} tokens, ${formatCost(u.estimatedCostUsd)}]`,
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

  /**
   * One model call for this turn, asked again with more room when the reply
   * was cut off by max_tokens in the middle of a tool call. Undefined when
   * the caller aborted it.
   */
  private async callModel(
    turn: number,
    messages: ConversationMessage[],
    tools: Tool[],
    signal: AbortSignal | undefined,
    usageAccum: AgentUsage,
  ): Promise<{ response: ModelResponse; maxTokens: number } | undefined> {
    let maxTokens = this.config.maxTokens;
    let turnUsage: AgentUsage | undefined;

    for (;;) {
      let response: ModelResponse;
      try {
        response = await this.client.create(
          {
            model: this.config.model,
            system: this.buildSystemPrompt(),
            messages: this.buildApiMessages(messages),
            tools,
            maxTokens,
            thinking: this.config.thinking,
            effort: this.effort,
            enableCaching: this.config.enableCaching,
            stream: this.config.stream,
            signal,
          },
          (delta) => this.emitDelta(delta),
        );
      } catch (err) {
        if (signal?.aborted) return undefined;
        throw err;
      }

      const usage = this.accumulateUsage(response, usageAccum);
      turnUsage = turnUsage ? sumUsage(turnUsage, usage) : usage;

      const cutMidCall = response.stopReason === "max_tokens" && response.content.some((b) => b.type === "tool_use");
      if (cutMidCall && maxTokens < MAX_RETRY_TOKENS && !signal?.aborted) {
        const next = Math.min(maxTokens * 2, MAX_RETRY_TOKENS);
        logger.warn(`Turn ${turn} was cut off at max_tokens=${maxTokens} mid tool call; asking again with ${next}`);
        await this.emit({
          type: "turn_retry",
          turn,
          reason: `cut off at max_tokens=${maxTokens} in the middle of a tool call`,
          maxTokens: next,
        });
        maxTokens = next;
        continue;
      }

      await this.emit({ type: "turn_end", turn, usage: turnUsage });
      return { response, maxTokens };
    }
  }

  /**
   * Run one turn's tool calls, returning their results in the order asked.
   *
   * Calls that change nothing run together, up to AGENT_MAX_CONCURRENT_TOOLS
   * at a time; a dangerous call (Bash, Write, Edit) waits for what came
   * before it and runs alone. Everything used to run at once, and two Edits
   * of one file in the same turn then read the same original: over 100
   * turns on a 1 MB file, one edit was lost in 92–98 of them and the file
   * was cut short in up to 7, with both calls reporting success.
   */
  private async executeTools(
    toolUseBlocks: Anthropic.ToolUseBlockParam[],
    toolCallRecords: ToolCallRecord[],
    context: ToolContext,
    signal: AbortSignal | undefined,
  ): Promise<Anthropic.ToolResultBlockParam[]> {
    const results: Anthropic.ToolResultBlockParam[] = [];
    const maxConcurrent = Math.max(1, Number(process.env.AGENT_MAX_CONCURRENT_TOOLS ?? 4) || 4);

    let together: Anthropic.ToolUseBlockParam[] = [];
    const flush = async () => {
      for (const batch of chunk(together, maxConcurrent)) {
        results.push(
          ...(await Promise.all(batch.map((block) => this.executeTool(block, toolCallRecords, context, signal)))),
        );
      }
      together = [];
    };

    for (const block of toolUseBlocks) {
      // An unknown tool counts as dangerous: it is refused, but in order.
      if (this.registry.get(block.name)?.dangerous === false) {
        together.push(block);
        continue;
      }
      await flush();
      results.push(await this.executeTool(block, toolCallRecords, context, signal));
    }
    await flush();

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
    await this.emit({
      type: "tool_request",
      toolUseId,
      toolName: block.name,
      input: block.input as Record<string, unknown>,
    });

    const refuse = async (reason: string, content: string) => {
      await this.emit({ type: "tool_denied", toolUseId, toolName: block.name, reason });
      return { type: "tool_result" as const, tool_use_id: toolUseId, content, is_error: true };
    };

    const tool = this.registry.get(block.name);
    if (!tool) {
      logger.warn(`Unknown tool: ${block.name}`);
      return refuse("not registered", `Error: Tool "${block.name}" is not registered.`);
    }

    // Before the permission check, so a prompt or the gate never judges an
    // input the tool would not have accepted.
    const checked = tool.validate(block.input);
    if (!checked.ok) {
      return refuse("invalid input", `Error: invalid input for ${tool.name}: ${checked.error}. Fix the arguments and call it again.`);
    }
    const input = checked.value;

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
        return await this.capOutput(tool, toolUseId, context.sessionId, await tool.execute(input, context));
      } catch (err) {
        return { type: "error", message: `${tool.name} threw: ${err instanceof Error ? err.message : String(err)}` };
      }
    };
    let toolResult = await attempt();

    // One more try for a call that changes nothing, if the judge calls the
    // failure transient. Never for a dangerous tool, never twice.
    const retryJudge = this.retryJudge;
    if (toolResult.type === "error" && !tool.dangerous && retryJudge && !signal?.aborted) {
      const error = toolResult.message;
      const verdict = await settle(
        () => retryJudge({ toolName: tool.name, summary: tool.summarize(input), error }),
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

  /**
   * A result as the model sees it: at most MAX_TOOL_OUTPUT_CHARS, start and
   * end kept. The whole text goes to a file the note names, so the middle is
   * one Read away — unless the tool can simply be asked again in pieces.
   */
  private async capOutput(tool: Tool, toolUseId: string, sessionId: string, result: ToolResult): Promise<ToolResult> {
    const text = result.type === "success" ? result.output : result.message;
    if (text.length <= MAX_TOOL_OUTPUT_CHARS) return result;
    const note = tool.rereadHint ?? (await saveFullOutput(sessionId, toolUseId, text));
    const cut = truncateMiddle(text, MAX_TOOL_OUTPUT_CHARS, tool.outputHeadShare, note);
    return result.type === "success" ? { type: "success", output: cut } : { type: "error", message: cut };
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

  /** `Bash(npm test), Edit(src/a.ts: "x")` — what a turn's calls were, for the interruption note. */
  private describeCalls(blocks: Anthropic.ToolUseBlockParam[]): string {
    return blocks
      .map((b) => {
        const tool = this.registry.get(b.name);
        const input = b.input as Record<string, unknown>;
        try {
          return tool ? `${b.name}(${tool.summarize(input)})` : b.name;
        } catch {
          return b.name;
        }
      })
      .join(", ");
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

  /**
   * Nothing in here may change within a session: it heads the prompt, so a
   * change re-bills the whole conversation uncached. What does change — the
   * working directory, the date — goes into the conversation instead.
   */
  private buildSystemPrompt(): string {
    const parts = [BASE_SYSTEM_PROMPT];
    if (this.config.systemPrompt) parts.push(this.config.systemPrompt);
    // The model was never told, and wrote bash for a tool that ran cmd.exe.
    // The Bash tool's description names the shell itself.
    parts.push(`Platform: ${os.type()} ${os.release()} (${process.platform})`);
    return parts.join("\n\n");
  }

  /** The local date, not UTC: evening in the Americas is already tomorrow in UTC. */
  private environmentLine(): string {
    return `working directory ${this.config.cwd}; today is ${new Date().toLocaleDateString("sv-SE")}`;
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
    accum.estimatedCostUsd = addCost(accum.estimatedCostUsd, cost);

    return { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, estimatedCostUsd: cost };
  }

  /**
   * Write the session as it stands. A trailing assistant turn whose tool_use
   * has no result yet is left out, so what is on disk can always be resumed.
   */
  private async persist(
    base: Session,
    messages: ConversationMessage[],
    turns: number,
    usage: AgentUsage,
    interrupted: string | undefined,
  ): Promise<void> {
    if (!this.config.persistSessions) return;

    const { interrupted: _previous, ...meta } = base.metadata;
    const metadata: SessionMetadata = {
      ...meta,
      turns: meta.turns + turns,
      totalInputTokens: meta.totalInputTokens + usage.inputTokens,
      totalOutputTokens: meta.totalOutputTokens + usage.outputTokens,
      totalCost: addCost(meta.totalCost, usage.estimatedCostUsd),
      ...(interrupted ? { interrupted } : {}),
    };
    await this.sessions.save({ metadata, messages: withoutDanglingToolUse(messages) });
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
 * A judge's verdict, or `fallback` if the judge throws. The judges xavierjev
 * builds never throw, but a caller's own can, and a judge that fails has
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

/**
 * The prompt as the model receives it, with the harness's notes first.
 * Appended, never edited into earlier turns, so the cached prefix and the
 * history's thinking blocks stay valid.
 */
function userTurn(prompt: string, notes: string[]): ConversationMessage["content"] {
  if (notes.length === 0) return prompt;
  return [...notes.map((text) => ({ type: "text" as const, text })), { type: "text" as const, text: prompt }];
}

/** What to tell the caller when the model stopped for a reason other than finishing. */
function stopNotice(stopReason: string, maxTokens: number): string | undefined {
  switch (stopReason) {
    case "max_tokens":
      return `The reply hit max_tokens (${maxTokens.toLocaleString("en-US")}).`;
    case "refusal":
      return "The model declined to continue (stop_reason: refusal).";
    case "model_context_window_exceeded":
      return "The conversation no longer fits in the model's context window; start a new session.";
    default:
      return undefined;
  }
}

/** Where the whole of a cut result is kept, or undefined if it could not be written. */
async function saveFullOutput(sessionId: string, toolUseId: string, text: string): Promise<string | undefined> {
  const safe = (s: string) => s.replace(/[^\w-]/g, "_");
  const dir = path.join(process.env.AGENT_OUTPUT_DIR || path.join(os.tmpdir(), "agent-app-output"), safe(sessionId));
  const file = path.join(dir, `${safe(toolUseId)}.txt`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, text, "utf-8");
    return `the whole output is in ${file}`;
  } catch {
    return undefined;
  }
}

function sumUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    estimatedCostUsd: addCost(a.estimatedCostUsd, b.estimatedCostUsd),
  };
}

/** The history minus a trailing assistant turn that asked for tools it never got results for. */
function withoutDanglingToolUse(messages: ConversationMessage[]): ConversationMessage[] {
  const last = messages[messages.length - 1];
  const dangling =
    last?.role === "assistant" && Array.isArray(last.content) && last.content.some((b) => b.type === "tool_use");
  return dangling ? messages.slice(0, -1) : messages;
}
