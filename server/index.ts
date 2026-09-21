import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { registerBuiltinTools, globalRegistry } from "../src/tools/index.js";
import { AllowlistJudge } from "../src/judge/allowlist.js";
import { createRiskGate } from "../src/judge/gate.js";
import { LlmJudge } from "../src/judge/llm.js";
import { PermissionPresets, PermissionSystem } from "../src/permissions/index.js";
import { SessionManager } from "../src/session/manager.js";
import { estimateCost } from "../src/utils/cost.js";
import type {
  ConversationMessage,
  PermissionDecision,
  PermissionRequest,
  RiskGate,
} from "../src/types.js";

registerBuiltinTools();

// ─────────────────────────────────────────────
// The risk gate, and the approvals it cannot decide
// ─────────────────────────────────────────────

/**
 * Build the gate once, at boot, and probe it.
 *
 * The CLI does the same thing. It matters more here: a browser tab gives no
 * hint that a judge is silently deferring everything, so a judge that cannot
 * answer has to be reported at startup and then removed.
 */
async function buildGate(): Promise<{ gate: RiskGate | undefined; label: string }> {
  const wantsLlm = !!(process.env["AGENT_JUDGE_API_KEY"] || process.env["AGENT_JUDGE_BASE_URL"]);

  if (wantsLlm) {
    try {
      const judge = new LlmJudge();
      const capability = await judge.probe();
      if (capability.logprobs) {
        return { gate: createRiskGate({ backend: judge }), label: judge.name };
      }
      console.warn(`   judge ${judge.name} returned no logprobs (${capability.detail})`);
    } catch (err) {
      console.warn(`   judge unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.warn("   falling back to the offline allow-list");
  }

  return { gate: createRiskGate({ backend: new AllowlistJudge() }), label: "allowlist" };
}

const { gate, label: gateLabel } = await buildGate();

/**
 * Approvals waiting on a human, keyed by an id the browser echoes back.
 *
 * This is what `PermissionPrompt` being injectable was for. The framework
 * never assumes the question can be asked on stdin — the CLI answers it from
 * its own line reader, and here it goes out over the SSE stream and comes
 * back as a separate POST, with the tool call parked on a promise in between.
 */
const pendingApprovals = new Map<string, (decision: PermissionDecision) => void>();

/** Long enough for a human to read a command, short enough to not leak. */
const APPROVAL_TIMEOUT_MS = 120_000;

const app = express();
app.use(cors());
app.use(express.json());

const sessions = new SessionManager();

// ─────────────────────────────────────────────
// GET /api/health
// ─────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    hasApiKey: !!process.env["ANTHROPIC_API_KEY"],
    tools: globalRegistry.names(),
  });
});

// ─────────────────────────────────────────────
// GET /api/sessions
// ─────────────────────────────────────────────
app.get("/api/sessions", async (_req, res) => {
  const list = await sessions.list();
  res.json(list.slice(0, 20));
});

// ─────────────────────────────────────────────
// DELETE /api/sessions/:id
// ─────────────────────────────────────────────
app.delete("/api/sessions/:id", async (req, res) => {
  await sessions.delete(req.params["id"] ?? "");
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// POST /api/permission  (answer a parked tool call)
// ─────────────────────────────────────────────
app.post("/api/permission", (req, res) => {
  const { id, decision } = req.body as { id?: string; decision?: PermissionDecision };
  const resolve = id ? pendingApprovals.get(id) : undefined;

  if (!resolve || !id) {
    // Already answered, timed out, or never existed. Not an error worth
    // failing the request over — the tool call has moved on either way.
    res.status(404).json({ ok: false, reason: "no pending approval with that id" });
    return;
  }

  const valid: PermissionDecision[] = ["allow", "deny", "always-allow", "always-deny"];
  if (!decision || !valid.includes(decision)) {
    res.status(400).json({ ok: false, reason: `decision must be one of ${valid.join(", ")}` });
    return;
  }

  pendingApprovals.delete(id);
  resolve(decision);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// POST /api/chat  (SSE streaming)
// ─────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { message, sessionId, apiKey, baseURL, model = "claude-opus-5", allowedTools } = req.body as {
    message: string;
    sessionId?: string;
    apiKey?: string;
    baseURL?: string;
    model?: string;
    allowedTools?: string[];
  };

  const resolvedKey = apiKey || process.env["ANTHROPIC_API_KEY"] || process.env["OPENAI_API_KEY"];
  if (!resolvedKey) {
    res.status(400).json({ error: "API Key is required" });
    return;
  }

  // Detect if we should use OpenAI-compatible mode:
  // - explicit baseURL provided, OR
  // - key doesn't start with sk-ant- (not an Anthropic key)
  const useOpenAI = !!(baseURL || (resolvedKey && !resolvedKey.startsWith("sk-ant-")));

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Load or create session
    let session = sessionId ? await sessions.load(sessionId) : null;
    if (!session) {
      session = await sessions.create({
        model,
        cwd: process.cwd(),
        turns: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
      });
    }
    send("session", { sessionId: session.metadata.sessionId });

    // Append user message
    const userMsg: ConversationMessage = { role: "user", content: message };
    session = sessions.appendMessages(session, [userMsg]);
    const activeSessionId = session.metadata.sessionId;

    const tools = globalRegistry.resolve(
      allowedTools?.length ? allowedTools : undefined,
      []
    );
    // Ask before Bash/Write/Edit, let the gate clear the easy ones, and send
    // whatever is left to the browser. The previous behaviour here was
    // `defaultMode: "allow"` — the web UI ran every tool call without asking
    // and without saying so, which is the one configuration the CLI does not
    // offer.
    const permissions = new PermissionSystem({
      ...PermissionPresets.askDangerous(),
      // Wrapped rather than called a second time: the verdict is already
      // computed inside check(), and asking again would double the judge's
      // latency and cost on every tool call just to tell the browser about
      // it. Its whole effect otherwise is a prompt that does not appear.
      ...(gate
        ? {
            gate: async (request: PermissionRequest) => {
              const verdict = await gate(request);
              send("gate_verdict", {
                id: currentToolUseId,
                action: verdict.action,
                probability: verdict.probability,
                reason: verdict.reason,
                judge: gateLabel,
              });
              return verdict;
            },
          }
        : {}),
      prompt: (request: PermissionRequest) =>
        new Promise<PermissionDecision>((resolve) => {
          const id = randomUUID();
          let settled = false;
          const settle = (decision: PermissionDecision) => {
            if (settled) return;
            settled = true;
            pendingApprovals.delete(id);
            clearTimeout(timer);
            resolve(decision);
          };

          // Fail closed on silence, and on the tab going away.
          const timer = setTimeout(() => settle("deny"), APPROVAL_TIMEOUT_MS);
          res.once("close", () => settle("deny"));

          pendingApprovals.set(id, settle);
          send("permission_request", {
            id,
            toolName: request.toolName,
            input: request.input,
            description: request.description,
          });
        }),
    });

    // Which tool call the gate is currently being asked about. Safe because
    // runTools walks the batch sequentially; if it ever runs them in
    // parallel, the gate wrapper needs the id threaded through instead.
    let currentToolUseId: string | undefined;

    const systemPrompt = [
      "You are a helpful AI assistant with access to tools.",
      "You can read files, run shell commands, search the web, and more.",
      `Working directory: ${process.cwd()}`,
      `Date: ${new Date().toISOString().slice(0, 10)}`,
    ].join("\n");

    const messages: ConversationMessage[] = [...session.messages];
    let turn = 0;
    const MAX_TURNS = 20;
    let totalInput = 0, totalOutput = 0, totalCost = 0;

    // ── Helper: execute tool calls and return results ──
    async function runTools(toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>) {
      const results: Array<{ toolUseId: string; content: string; isError: boolean }> = [];
      for (const tc of toolCalls) {
        const tool = globalRegistry.get(tc.name);
        send("tool_start", { id: tc.id, name: tc.name, input: tc.input });

        if (!tool) {
          results.push({ toolUseId: tc.id, content: `Error: Tool "${tc.name}" not found`, isError: true });
          send("tool_end", { id: tc.id, name: tc.name, error: "Tool not found", durationMs: 0 });
          continue;
        }

        currentToolUseId = tc.id;
        const allowed = await permissions.check({
          toolName: tool.name,
          input: tc.input,
          description: tool.summarize(tc.input),
        });
        if (!allowed) {
          results.push({ toolUseId: tc.id, content: "Permission denied", isError: true });
          send("tool_end", { id: tc.id, name: tc.name, error: "Permission denied", durationMs: 0 });
          continue;
        }

        const start = Date.now();
        const result = await tool.execute(tc.input, {
          cwd: process.cwd(),
          sessionId: activeSessionId,
          agentId: "web",
          permissions: permissions.getContext(),
        });
        const durationMs = Date.now() - start;
        results.push({
          toolUseId: tc.id,
          content: result.type === "success" ? result.output : `Error: ${result.message}`,
          isError: result.type === "error",
        });
        send("tool_end", {
          id: tc.id, name: tc.name, durationMs,
          result: result.type === "success" ? result.output.slice(0, 500) : undefined,
          error: result.type === "error" ? result.message : undefined,
        });
      }
      return results;
    }

    while (turn < MAX_TURNS) {
      turn++;
      send("turn_start", { turn });

      let stopReason: string;
      let inputTokens = 0, outputTokens = 0;
      let pendingToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

      if (useOpenAI) {
        // ── OpenAI-compatible path ──
        const oai = new OpenAI({ apiKey: resolvedKey, baseURL: baseURL || undefined });
        const oaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
          { role: "system", content: systemPrompt },
          ...messages.map((m) => {
            if (typeof m.content === "string") {
              return { role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam;
            }
            // tool results
            if (m.role === "user" && Array.isArray(m.content)) {
              return (m.content as Array<{ tool_use_id: string; content: string }>).map((r) => ({
                role: "tool" as const,
                tool_call_id: r.tool_use_id,
                content: r.content,
              }));
            }
            // assistant with tool_use blocks
            if (m.role === "assistant" && Array.isArray(m.content)) {
              const textBlocks = (m.content as Array<{ type: string; text?: string }>)
                .filter((b) => b.type === "text")
                .map((b) => b.text ?? "")
                .join("");
              const toolUseBlocks = (m.content as Array<{ type: string; id?: string; name?: string; input?: unknown }>)
                .filter((b) => b.type === "tool_use");
              return {
                role: "assistant" as const,
                content: textBlocks || null,
                tool_calls: toolUseBlocks.map((b) => ({
                  id: b.id!,
                  type: "function" as const,
                  function: { name: b.name!, arguments: JSON.stringify(b.input) },
                })),
              } as OpenAI.Chat.ChatCompletionMessageParam;
            }
            return { role: m.role, content: String(m.content) } as OpenAI.Chat.ChatCompletionMessageParam;
          }).flat(),
        ];

        const oaiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
          type: "function" as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema as unknown as Record<string, unknown>,
          },
        }));

        const stream = await oai.chat.completions.create({
          model,
          messages: oaiMessages,
          ...(oaiTools.length > 0 && { tools: oaiTools, tool_choice: "auto" }),
          stream: true,
          stream_options: { include_usage: true },
        });

        let textBuffer = "";
        const toolCallBuffers: Record<number, { id: string; name: string; args: string }> = {};

        for await (const chunk of stream) {
          const choice = chunk.choices?.[0];
          if (!choice) {
            if (chunk.usage) { inputTokens = chunk.usage.prompt_tokens; outputTokens = chunk.usage.completion_tokens; }
            continue;
          }
          const delta = choice.delta;
          if (delta.content) {
            textBuffer += delta.content;
            send("text_delta", { delta: delta.content });
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!toolCallBuffers[tc.index]) {
                toolCallBuffers[tc.index] = { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" };
              }
              if (tc.id) toolCallBuffers[tc.index]!.id = tc.id;
              if (tc.function?.name) toolCallBuffers[tc.index]!.name = tc.function.name;
              if (tc.function?.arguments) toolCallBuffers[tc.index]!.args += tc.function.arguments;
            }
          }
          if (chunk.usage) { inputTokens = chunk.usage.prompt_tokens; outputTokens = chunk.usage.completion_tokens; }
          stopReason = choice.finish_reason ?? stopReason!;
        }

        pendingToolCalls = Object.values(toolCallBuffers).map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: (() => { try { return JSON.parse(tc.args); } catch { return {}; } })(),
        }));

        // Append assistant turn to messages
        if (pendingToolCalls.length > 0) {
          messages.push({
            role: "assistant",
            content: [
              ...(textBuffer ? [{ type: "text", text: textBuffer }] : []),
              ...pendingToolCalls.map((tc) => ({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input })),
            ] as ConversationMessage["content"],
          });
        } else {
          messages.push({ role: "assistant", content: textBuffer });
        }
      } else {
        // ── Anthropic path ──
        const client = new Anthropic({ apiKey: resolvedKey });
        const apiMessages = messages.map((m) => ({ role: m.role, content: m.content }));

        const stream = client.messages.stream({
          model,
          max_tokens: 16000,
          thinking: { type: "adaptive" },
          system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
          messages: apiMessages,
          tools: tools.map((t) => t.toAnthropicTool()),
          tool_choice: tools.length > 0 ? { type: "auto" } : undefined,
        } as Parameters<typeof client.messages.stream>[0]);

        for await (const event of stream) {
          if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") {
              send("text_delta", { delta: event.delta.text });
            } else if (event.delta.type === "thinking_delta") {
              send("thinking_delta", { delta: event.delta.thinking });
            }
          }
        }

        const response = await stream.finalMessage();
        const u = response.usage as Anthropic.Usage & { cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
        inputTokens = u.input_tokens;
        outputTokens = u.output_tokens;
        stopReason = response.stop_reason ?? "end_turn";

        pendingToolCalls = response.content
          .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }));

        messages.push({ role: "assistant", content: response.content });
      }

      const cost = estimateCost(model, inputTokens, outputTokens);
      totalInput += inputTokens;
      totalOutput += outputTokens;
      totalCost += cost;

      send("turn_end", { turn, usage: { inputTokens, outputTokens, cost } });

      if (pendingToolCalls.length === 0) break;

      // Execute tools
      const toolResults = await runTools(pendingToolCalls);

      if (useOpenAI) {
        // For OpenAI: append one tool result message per tool call
        for (const r of toolResults) {
          messages.push({
            role: "user",
            content: [{ tool_use_id: r.toolUseId, content: r.content }] as ConversationMessage["content"],
          });
        }
      } else {
        messages.push({
          role: "user",
          content: toolResults.map((r) => ({
            type: "tool_result",
            tool_use_id: r.toolUseId,
            content: r.content,
            is_error: r.isError,
          })) as ConversationMessage["content"],
        });
      }
    }

    // Persist session
    session = sessions.appendMessages(session, messages.slice(session.messages.length - 1));
    session = await sessions.updateMetadata(session, {
      turns: session.metadata.turns + turn,
      totalInputTokens: session.metadata.totalInputTokens + totalInput,
      totalOutputTokens: session.metadata.totalOutputTokens + totalOutput,
      totalCost: session.metadata.totalCost + totalCost,
    });
    await sessions.save(session);

    send("done", {
      sessionId: session.metadata.sessionId,
      turns: turn,
      usage: { inputTokens: totalInput, outputTokens: totalOutput, cost: totalCost },
    });

    res.end();
  } catch (err) {
    send("error", { message: String(err) });
    res.end();
  }
});

const PORT = Number(process.env["PORT"] ?? 3001);
app.listen(PORT, () => {
  console.log(`\n🚀 Agent API server running at http://localhost:${PORT}`);
  console.log(`   API Key: ${process.env["ANTHROPIC_API_KEY"] ? "✓ set" : "✗ not set (enter in UI)"}`);
  console.log(`   Tools: ${globalRegistry.names().join(", ")}`);
  console.log(`   Risk gate: ${gate ? gateLabel : "off"} — asks before Bash / Write / Edit\n`);
});
