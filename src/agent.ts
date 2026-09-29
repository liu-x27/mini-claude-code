import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";
import { COMPACTION_PROMPT, compactedHistory, defaultCompactAt, renderTranscript } from "./context/compaction.js";
import { loadProjectInstructions } from "./context/instructions.js";
import { discoverSkills, SkillTool, skillsNote } from "./context/skills.js";
import { GENERAL_PURPOSE, TaskTool } from "./tools/task.js";
import { TodoWriteTool } from "./tools/todo.js";
import { type HookEvent, type HookInput, type HookOutcome, type HooksConfig, runHooks } from "./hooks/index.js";
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
  PermissionRequest,
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

const DEFAULT_MODEL = "claude-opus-5-5";
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_TOKENS = 16_000;
/** How far a turn cut off mid tool call may raise max_tokens, doubling each time. */
const MAX_RETRY_TOKENS = 64_000;
/**
 * Tools the Agent adds itself rather than taking from the registry. A host
 * that lists tools for the user to switch on and off, and passes the result
 * as allowedTools, has to list these too, or they are never offered.
 */
export const AGENT_TOOL_NAMES = ["TodoWrite", "Task", "Skill"];

/** How many times a Stop hook may send the model back to work in one run. */
const MAX_STOP_CONTINUATIONS = 5;

const SUBAGENT_NOTE =
  "You are a subagent, working on one task for another agent. It sees nothing of what you do except your final message, so make that message a complete, self-contained answer to the task.";

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
 * const agent = new Agent({ model: "claude-opus-5-5" });
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
  private config: Required<
    Omit<AgentConfig, "router" | "client" | "retryJudge" | "stopJudge" | "effort" | "compactAt" | "hooks">
  >;
  private registry: ToolRegistry;
  private permissions: PermissionSystem;
  private sessions: SessionManager;
  private eventHandlers: AgentEventHandler[] = [];
  private router: ModelRouter | undefined;
  private retryJudge: RetryJudge | undefined;
  private stopJudge: StopJudge | undefined;
  private effort: EffortLevel | undefined;
  private compactAt: number | false | undefined;
  private hooks: HooksConfig | undefined;
  /** The session the current run is on, for hook input. */
  private sessionId = "";
  /** Set when a hook answers `continue: false`: the run ends after the call in progress. */
  private hookStop: string | undefined;
  /** Tools the agent adds to the registry's for a run: the Skill tool, when there are skills, and Task. */
  private extraTools = new Map<string, Tool>();
  /** 0 for an agent a caller made; 1 for a subagent, which gets no Task tool. */
  private depth = 0;
  /** The current run's signal and usage, which a subagent the run starts shares. */
  private runSignal: AbortSignal | undefined;
  private runUsage: AgentUsage | undefined;

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
      skills: config.skills ?? true,
      stream: config.stream ?? false,
    };

    this.router = config.router;
    this.retryJudge = config.retryJudge;
    this.stopJudge = config.stopJudge;
    this.effort = config.effort;
    this.compactAt = config.compactAt;
    this.hooks = config.hooks;

    this.registry = registry ?? globalRegistry;
    this.permissions = new PermissionSystem({
      ...this.config.permissions,
      ...(this.hooks?.PermissionRequest ? { onAsk: (request: PermissionRequest) => this.permissionRequestHook(request) } : {}),
    });
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
    const skills = this.config.skills ? await discoverSkills(this.config.cwd) : [];
    this.extraTools.clear();
    // Tool<SkillInput> is a Tool: the registry holds its tools the same way.
    if (skills.length > 0) this.offer(new SkillTool() as unknown as Tool);
    this.offer(new TodoWriteTool() as unknown as Tool);
    if (this.depth === 0) {
      this.offer(new TaskTool(this.config.subagents, (type, task) => this.runSubagent(type, task)) as unknown as Tool);
    }
    const tools = [...this.resolveTools(), ...this.extraTools.values()];
    this.runSignal = signal;
    const session = await this.initSession();
    await this.emit({
      type: "session",
      sessionId: session.metadata.sessionId,
      resumed: session.messages.length > 0,
    });
    await this.route(prompt, session);
    this.sessionId = session.metadata.sessionId;
    this.hookStop = undefined;

    const toolCalls: ToolCallRecord[] = [];
    const usageAccum: AgentUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      estimatedCostUsd: 0,
    };
    this.runUsage = usageAccum;

    const messages: ConversationMessage[] = [...session.messages];
    const notes: string[] = [];
    if (session.messages.length === 0 && this.config.projectInstructions) {
      const instructions = await loadProjectInstructions(this.config.cwd);
      if (instructions) notes.push(instructions);
      if (skills.length > 0) notes.push(skillsNote(skills));
    }
    const environment = this.environmentLine();
    if (session.metadata.environment !== environment) notes.push(`[Environment: ${environment}]`);
    if (session.metadata.interrupted) {
      notes.push(
        `[Note from the harness: the previous run in this session ended early — ${session.metadata.interrupted}. The history above is what was recorded; check the current state before relying on its last step.]`,
      );
    }
    session.metadata.environment = environment;

    if (session.messages.length === 0) {
      const start = await this.hook("SessionStart", { source: "startup" });
      notes.push(...start.context.map((c) => `[SessionStart hook: ${c}]`));
    }
    const submitted = await this.hook("UserPromptSubmit", { prompt });
    if (submitted.block !== undefined || submitted.stop !== undefined) {
      // The prompt is dropped, as Claude Code drops it: nothing reaches the model or the session.
      const result: AgentResult = {
        text: `Blocked by a UserPromptSubmit hook: ${submitted.block ?? submitted.stop}`,
        stopReason: "blocked",
        turns: 0,
        toolCalls: [],
        usage: usageAccum,
        sessionId: session.metadata.sessionId,
      };
      await this.emit({ type: "done", result });
      return result;
    }
    notes.push(...submitted.context.map((c) => `[UserPromptSubmit hook: ${c}]`));

    // The session may already be past the budget: its last call said how big it was.
    let promptTokens = session.metadata.contextTokens ?? 0;
    if (messages.length > 0 && promptTokens >= this.compactionTrigger()) {
      const compacted = await this.compact(messages, tools, signal, usageAccum, session, 0, undefined);
      if (compacted) {
        messages.splice(0, messages.length, ...compacted);
        promptTokens = 0;
      }
    }
    messages.push({ role: "user", content: userTurn(prompt, notes) });

    let turn = 0;
    let stopContinuations = 0;
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

        // Between turns, never inside one: the history ends in a user
        // message here, so no tool_use is waiting for its result.
        if (turn > 1 && promptTokens >= this.compactionTrigger()) {
          const compacted = await this.compact(messages, tools, signal, usageAccum, session, turn, prompt);
          if (compacted) {
            messages.splice(0, messages.length, ...compacted);
            promptTokens = 0;
            await save();
          }
        }

        const called = await this.callModel(turn, messages, tools, signal, usageAccum);
        if (!called) {
          finalStopReason = "aborted";
          break;
        }
        const { response, maxTokens } = called;
        const u = response.usage;
        promptTokens = u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens;
        session.metadata.contextTokens = promptTokens;

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
              agentId: this.depth === 0 ? "main" : "subagent",
              permissions: this.permissions.getContext(),
              todos: {
                set: (items) => {
                  session.metadata.todos = items;
                  void this.emit({ type: "todos", todos: items });
                },
              },
            },
            signal,
          );

          // Append tool results as user message
          messages.push({ role: "user", content: toolResults });
          await save();

          if (this.hookStop !== undefined) {
            finalStopReason = "stopped_by_hook";
            finalText = `Stopped by a hook: ${this.hookStop}`;
            break;
          }

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

        // A Stop hook can send the model back to work, a few times at most;
        // stop_hook_active tells the hook it already has once this run.
        if (response.stopReason === "end_turn" && stopContinuations < MAX_STOP_CONTINUATIONS) {
          const stop = await this.hook("Stop", { stop_hook_active: stopContinuations > 0 });
          if (stop.block !== undefined) {
            stopContinuations++;
            messages.push({ role: "user", content: `[Stop hook: ${stop.block}]` });
            await save();
            continue;
          }
        }
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

  /** Prompt tokens past which the conversation is compacted before the next call. */
  private compactionTrigger(): number {
    if (this.compactAt === false) return Number.POSITIVE_INFINITY;
    return this.compactAt ?? defaultCompactAt(this.config.model);
  }

  /**
   * Ask the model to summarise the conversation, archive the full one, and
   * return the history to continue from — or undefined, and carry on
   * uncompacted, if any of that fails. The request is the conversation's
   * own (same system, same tools, with tool_choice none), so it reads the
   * cached prefix instead of paying for the history a second time.
   */
  private async compact(
    messages: ConversationMessage[],
    tools: Tool[],
    signal: AbortSignal | undefined,
    usageAccum: AgentUsage,
    session: Session,
    turn: number,
    continuing: string | undefined,
  ): Promise<ConversationMessage[] | undefined> {
    const promptTokens = session.metadata.contextTokens ?? 0;
    const ask = async (history: ConversationMessage[], withTools: Tool[]) => {
      const response = await this.client.create(
        {
          model: this.config.model,
          system: this.buildSystemPrompt(),
          messages: this.buildApiMessages(history),
          tools: withTools,
          ...(withTools.length > 0 ? { toolChoice: "none" as const } : {}),
          maxTokens: this.config.maxTokens,
          thinking: this.config.thinking,
          effort: this.effort,
          enableCaching: this.config.enableCaching,
          stream: false,
          signal,
        },
        async () => undefined,
      );
      this.accumulateUsage(response, usageAccum);
      return { text: this.extractText(response.content).trim(), stopReason: response.stopReason };
    };
    try {
      let { text: summary, stopReason } = await ask([...messages, { role: "user", content: COMPACTION_PROMPT }], tools);
      if (!summary && !signal?.aborted) {
        logger.warn(`Compaction got no summary (stop_reason ${stopReason}); asking again over a plain-text transcript`);
        const flat = `${renderTranscript(messages)}\n\n---\n\n${COMPACTION_PROMPT}`;
        ({ text: summary, stopReason } = await ask([{ role: "user", content: flat }], []));
      }
      if (!summary) {
        logger.warn(`Compaction returned no summary (stop_reason ${stopReason}); carrying on uncompacted`);
        return undefined;
      }
      // Only now, so a compaction that fails leaves no archive behind.
      const transcript = await this.archiveTranscript(session.metadata.sessionId, messages);
      session.metadata.compactions = (session.metadata.compactions ?? 0) + 1;
      session.metadata.contextTokens = 0;
      await this.emit({ type: "compacted", turn, promptTokens, transcript });
      return compactedHistory(summary, transcript, continuing);
    } catch (err) {
      if (!signal?.aborted) {
        logger.warn(`Compaction failed, carrying on uncompacted: ${err instanceof Error ? err.message : String(err)}`);
      }
      return undefined;
    }
  }

  /** Where the pre-compaction transcript is kept: beside the sessions, or with the tool output when none are saved. */
  private async archiveTranscript(sessionId: string, messages: ConversationMessage[]): Promise<string | undefined> {
    try {
      if (this.config.persistSessions) return await this.sessions.archive(sessionId, messages);
      const dir = path.join(outputDir(), safeName(sessionId));
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `transcript-${Date.now()}.json`);
      await fs.writeFile(file, JSON.stringify(messages, null, 2), "utf-8");
      return file;
    } catch {
      return undefined;
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
      if (this.lookup(block.name)?.dangerous === false) {
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

    const tool = this.lookup(block.name);
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
    let input = checked.value;

    const pre = await this.hook("PreToolUse", { tool_name: tool.name, tool_input: input, tool_use_id: toolUseId }, tool.name);
    if (pre.stop !== undefined) this.hookStop = pre.stop;
    if (pre.block !== undefined) return refuse("blocked by hook", `Blocked by a PreToolUse hook: ${pre.block}`);
    if (pre.updatedInput) {
      const rewritten = tool.validate(pre.updatedInput);
      if (!rewritten.ok) {
        return refuse("invalid input", `Error: a PreToolUse hook rewrote the input into one ${tool.name} does not accept: ${rewritten.error}`);
      }
      input = rewritten.value;
    }

    // Permission check
    const allowed = await this.permissions.check(
      {
        toolName: tool.name,
        input,
        description: tool.summarize(input),
        toolUseId,
        cwd: context.cwd,
      },
      pre.allow ? { hook: "allow" } : pre.ask ? { hook: "ask" } : {},
    );
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

    const post = await this.hook(
      "PostToolUse",
      { tool_name: tool.name, tool_input: input, tool_use_id: toolUseId, tool_response: toolResult },
      tool.name,
    );
    if (post.stop !== undefined) this.hookStop = post.stop;
    const notes = [...(post.block !== undefined ? [post.block] : []), ...post.context].map((n) => `[PostToolUse hook: ${n}]`);
    const content = toolResult.type === "success" ? toolResult.output : `Error: ${toolResult.message}`;

    return {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: notes.length > 0 ? `${content}\n\n${notes.join("\n")}` : content,
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

  /** Run the hooks for one event with the input every event carries. */
  private hook(event: HookEvent, fields: Partial<HookInput>, toolName?: string): Promise<HookOutcome> {
    if (!this.hooks?.[event]) return Promise.resolve({ context: [] });
    const input: HookInput = {
      hook_event_name: event,
      session_id: this.sessionId,
      cwd: this.config.cwd,
      permission_mode: "default",
      ...(this.config.persistSessions && this.sessionId ? { transcript_path: this.sessions.pathFor(this.sessionId) } : {}),
      ...fields,
    };
    return runHooks(this.hooks, event, input, toolName);
  }

  /** The PermissionRequest hook, asked before the gate and the user. */
  private async permissionRequestHook(request: PermissionRequest): Promise<"allow" | "deny" | undefined> {
    const outcome = await this.hook(
      "PermissionRequest",
      { tool_name: request.toolName, tool_input: request.input, ...(request.toolUseId ? { tool_use_id: request.toolUseId } : {}) },
      request.toolName,
    );
    if (outcome.block !== undefined) return "deny";
    return outcome.allow ? "allow" : undefined;
  }

  /** The last few calls, as the stop judge sees them. */
  private trace(records: ToolCallRecord[]): TracedCall[] {
    return records.slice(-8).map((r) => {
      const tool = this.lookup(r.toolName);
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
        const tool = this.lookup(b.name);
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
   * Let the router pick the model for this session, if one is configured.
   *
   * Once per session, on its first prompt; a resumed session keeps the model
   * it was routed to. The REPL runs each prompt as a run of its own, so
   * routing per run switched models inside one conversation, and every
   * switch throws away the prompt cache (caches are per model) and, on
   * current Claude models, the thinking the other model wrote.
   *
   * Mutates `config.model` rather than threading a per-call model through
   * every API path, because every call in the session should agree with
   * it. It emits nothing: the routing event belongs to whatever installed
   * the router, and the CLI logs it there.
   */
  private async route(prompt: string, session: Session): Promise<void> {
    if (!this.router) return;
    if (session.messages.length > 0) {
      this.config.model = session.metadata.model;
      return;
    }

    const verdict = await this.router(prompt);
    if (verdict.model !== this.config.model) {
      logger.debug(
        `Router chose ${verdict.model} over ${this.config.model} — ${verdict.reason}`,
      );
    }
    this.config.model = verdict.model;
    session.metadata.model = verdict.model;
  }

  /** Add a tool of the agent's own for this run, unless allowedTools / disallowedTools rule it out. */
  private offer(tool: Tool): void {
    const { allowedTools, disallowedTools } = this.config;
    if (allowedTools.length > 0 && !allowedTools.includes(tool.name)) return;
    if (disallowedTools.includes(tool.name)) return;
    this.extraTools.set(tool.name, tool);
  }

  /**
   * Run a subagent for the Task tool: same client and working directory, a
   * fresh conversation, and this agent's permission system, so its calls are
   * asked about in the same queue, under the same rules and gate. Its usage
   * is added to this run's, and what it does is reported as `subagent` events.
   */
  private async runSubagent(type: string, task: string): Promise<{ text: string; stopReason: string }> {
    const def = type === GENERAL_PURPOSE ? undefined : this.config.subagents[type];
    const hooks = this.hooks
      ? {
          ...(this.hooks.PreToolUse ? { PreToolUse: this.hooks.PreToolUse } : {}),
          ...(this.hooks.PermissionRequest ? { PermissionRequest: this.hooks.PermissionRequest } : {}),
          ...(this.hooks.PostToolUse ? { PostToolUse: this.hooks.PostToolUse } : {}),
        }
      : undefined;
    const child = new Agent(
      {
        client: this.client,
        model: def?.model ?? this.config.model,
        systemPrompt: [def?.systemPrompt, SUBAGENT_NOTE].filter(Boolean).join("\n\n"),
        cwd: this.config.cwd,
        maxTurns: this.config.maxTurns,
        maxTokens: this.config.maxTokens,
        thinking: this.config.thinking,
        ...(this.effort ? { effort: this.effort } : {}),
        ...(this.compactAt !== undefined ? { compactAt: this.compactAt } : {}),
        allowedTools: def?.allowedTools ?? this.config.allowedTools,
        disallowedTools: this.config.disallowedTools,
        persistSessions: false,
        enableCaching: this.config.enableCaching,
        projectInstructions: this.config.projectInstructions,
        skills: false,
        stream: false,
        ...(hooks ? { hooks } : {}),
        ...(this.retryJudge ? { retryJudge: this.retryJudge } : {}),
        ...(this.stopJudge ? { stopJudge: this.stopJudge } : {}),
      },
      this.registry,
    );
    child.depth = this.depth + 1;
    child.permissions = this.permissions;
    child.on((event) => this.emit({ type: "subagent", subagent: type, event }));

    const result = await child.run(task, { signal: this.runSignal });
    if (this.runUsage) Object.assign(this.runUsage, sumUsage(this.runUsage, result.usage));
    return { text: result.text, stopReason: result.stopReason };
  }

  private lookup(name: string): Tool | undefined {
    return this.extraTools.get(name) ?? this.registry.get(name);
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

function outputDir(): string {
  return process.env.AGENT_OUTPUT_DIR || path.join(os.tmpdir(), "agent-app-output");
}

function safeName(s: string): string {
  return s.replace(/[^\w-]/g, "_");
}

/** Where the whole of a cut result is kept, or undefined if it could not be written. */
async function saveFullOutput(sessionId: string, toolUseId: string, text: string): Promise<string | undefined> {
  const dir = path.join(outputDir(), safeName(sessionId));
  const file = path.join(dir, `${safeName(toolUseId)}.txt`);
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
