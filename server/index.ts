import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { Agent } from "../src/agent.js";
import {
  AllowlistJudge,
  anyStopJudge,
  createRepeatStopJudge,
  createRiskGate,
  createStopJudge,
  LlmJudge,
  patternRetryJudge,
  type ChoiceBackend,
  type JudgeBackend,
} from "xavierjev";
import { AnthropicClient } from "../src/model/anthropic.js";
import { OpenAICompatibleClient } from "../src/model/openai.js";
import type { ModelClient } from "../src/model/types.js";
import { PermissionPresets } from "../src/permissions/index.js";
import { SessionManager } from "../src/session/manager.js";
import { globalRegistry, registerBuiltinTools } from "../src/tools/index.js";
import type {
  AgentEvent,
  GateVerdict,
  PermissionDecision,
  PermissionRequest,
  RiskGate,
} from "../src/types.js";

import { FLAP_QUESTION, flapState, forcedFlap, isFlight } from "../shared/flappy.js";
import { isBoard, snakeQuestion } from "../shared/snake.js";

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
async function buildGate(): Promise<{ gate: RiskGate | undefined; label: string; model?: LlmJudge }> {
  const wantsLlm = !!(process.env["AGENT_JUDGE_API_KEY"] || process.env["AGENT_JUDGE_BASE_URL"]);

  if (wantsLlm) {
    try {
      const judge = new LlmJudge();
      const capability = await judge.probe();
      if (capability.logprobs) {
        // The same model answers the arena's questions; the allow-list
        // fallback below cannot, so the arena needs this branch.
        return { gate: createRiskGate({ backend: judge }), label: judge.name, model: judge };
      }
      console.warn(`   judge ${judge.name} returned no logprobs (${capability.detail})`);
    } catch (err) {
      console.warn(`   judge unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.warn("   falling back to the offline allow-list");
  }

  return { gate: createRiskGate({ backend: new AllowlistJudge() }), label: "allowlist" };
}

const { gate, label: gateLabel, model: arenaJudge } = await buildGate();
/** Snake asks it to pick one of four; Flappy asks it yes or no. */
const chooser: ChoiceBackend | undefined = arenaJudge;
const flapJudge: JudgeBackend | undefined = arenaJudge;

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

/**
 * Only this machine may drive the agent.
 *
 * The API runs tools on the host and has no login, so who can reach it is
 * the whole of its access control. Three things keep that to this machine:
 * the socket is bound to loopback, so nothing on the network can connect; a
 * Host header that is not a loopback name is refused, which is what a
 * DNS-rebinding page would send; and an Origin from anywhere but a loopback
 * page is refused, which is what any other website's fetch would send. There
 * are no CORS headers at all — the client reaches the API through the Vite
 * proxy, same-origin, and never needed them.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopback(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function localOnly(req: Request, res: Response, next: NextFunction): void {
  const { host, origin } = req.headers;
  if (!host || !isLoopback(`http://${host}`) || (origin !== undefined && !isLoopback(origin))) {
    res.status(403).json({ ok: false, reason: "this API only answers pages served from this machine" });
    return;
  }
  next();
}

const app = express();
app.use(localOnly);
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
    judge: gate ? gateLabel : null,
    // Whether the snake arena can ask a model, or only run its rule.
    choice: chooser ? chooser.name : null,
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
// POST /api/snake/move
// ─────────────────────────────────────────────
/** Past this, a move is a fallback: the game should not wait on a hung judge. */
const SNAKE_TIMEOUT_MS = 3000;

/**
 * One move in the snake arena, decided by the judge's `choice()`.
 *
 * Takes a board rather than a prompt. The question is built here, from
 * shared/snake.ts, so the browser can ask for a move and nothing else — this
 * is not a way to put arbitrary text in front of the judge model.
 */
app.post("/api/snake/move", async (req, res) => {
  if (!chooser) {
    res.status(503).json({
      error: "No model judge — start the server with AGENT_JUDGE_BASE_URL and AGENT_JUDGE_MODEL set.",
    });
    return;
  }
  const { board, mode } = (req.body ?? {}) as { board?: unknown; mode?: unknown };
  if (!isBoard(board)) {
    res.status(400).json({ error: "not a valid board" });
    return;
  }
  const question = snakeQuestion(board, mode === "raw" ? "raw" : "facts");
  if (question.options.length === 0) {
    res.status(422).json({ error: "no legal move" });
    return;
  }
  if (question.options.length === 1) {
    // Nothing to decide, and not worth a round trip to say so.
    res.json({ answers: [{ id: question.options[0]!.id, probability: 1 }], coverage: 1, latencyMs: 0, forced: true });
    return;
  }

  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      chooser.choice(question.state, question.ask, question.options),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${SNAKE_TIMEOUT_MS} ms`)), SNAKE_TIMEOUT_MS);
      }),
    ]);
    res.json({ ...result, latencyMs: Math.round(performance.now() - started), judge: chooser.name });
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Math.round(performance.now() - started),
    });
  } finally {
    clearTimeout(timer);
  }
});

// ─────────────────────────────────────────────
// POST /api/flappy/flap
// ─────────────────────────────────────────────
/**
 * One tick of Flappy: flap or not, as P(yes) from the judge.
 *
 * No deadline here. The browser owns the clock — it decides whether an
 * answer came back in time, and does not send the next question while this
 * one is still being answered — so the server's only job is to answer, and
 * to say how long the judge took.
 */
app.post("/api/flappy/flap", async (req, res) => {
  if (!flapJudge) {
    res.status(503).json({
      error: "No model judge — start the server with AGENT_JUDGE_BASE_URL and AGENT_JUDGE_MODEL set.",
    });
    return;
  }
  const { flight } = (req.body ?? {}) as { flight?: unknown };
  if (!isFlight(flight)) {
    res.status(400).json({ error: "not a valid flight" });
    return;
  }
  const forced = forcedFlap(flight);
  if (forced !== undefined) {
    // Flapping would crash: the rule's call, not a question.
    res.json({ probability: forced ? 1 : 0, latencyMs: 0, forced: true });
    return;
  }
  const started = performance.now();
  try {
    const [answer] = await flapJudge.noul(flapState(flight), [FLAP_QUESTION]);
    const p = answer?.probability;
    if (typeof p !== "number" || !(p >= 0 && p <= 1)) throw new Error("the judge gave no probability");
    res.json({ probability: p, latencyMs: Math.round(performance.now() - started), judge: flapJudge.name });
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Math.round(performance.now() - started),
    });
  }
});

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

type Provider = "anthropic" | "openai";

/**
 * Which API the browser's settings speak.
 *
 * Explicit when the client says so. Otherwise inferred the way the settings
 * presets are laid out — the Anthropic preset is the one with no base URL —
 * rather than from the key's prefix, which sent every Anthropic-compatible
 * provider (MiniMax, a local Ollama) through the OpenAI SDK.
 */
function resolveClient(body: {
  provider?: unknown;
  apiKey?: string | undefined;
  baseURL?: string | undefined;
}): ModelClient | string {
  const provider: unknown = body.provider ?? (body.baseURL ? "openai" : "anthropic");
  if (provider !== "anthropic" && provider !== "openai") {
    return `provider must be "anthropic" or "openai"`;
  }
  const envKey = (provider as Provider) === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const apiKey = body.apiKey || process.env[envKey];
  if (!apiKey) return `An API key is required: enter one in Settings, or set ${envKey} for the server`;

  return provider === "anthropic"
    ? new AnthropicClient({ apiKey, baseURL: body.baseURL })
    : new OpenAICompatibleClient({ apiKey, baseURL: body.baseURL });
}

/**
 * One chat message, run by the same `Agent` the CLI and the library use.
 *
 * All this handler owns is the transport: the agent's events go out as SSE,
 * its permission prompts come back through POST /api/permission, and the
 * tab closing aborts the run. The events keep the names and shapes the
 * browser already reads.
 */
app.post("/api/chat", async (req, res) => {
  const { message, sessionId, model = "claude-opus-5", allowedTools, ...rest } = req.body as {
    message?: unknown;
    sessionId?: string;
    apiKey?: string;
    baseURL?: string;
    provider?: unknown;
    model?: string;
    allowedTools?: string[];
  };

  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  const client = resolveClient(rest);
  if (typeof client === "string") {
    res.status(400).json({ error: client });
    return;
  }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const send = (event: string, data: unknown) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Stop, or the tab closing, ends the run — the model call in flight, the
  // approvals parked on it, and every turn after. "close" also fires after a
  // normal res.end(), which is why it is checked against writableFinished.
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  // What the gate said about each call, so an approval card can show the
  // probability it was deferred on.
  const verdicts = new Map<string, GateVerdict>();

  const agent = new Agent({
    client,
    model,
    cwd: process.cwd(),
    stream: true,
    ...(allowedTools?.length ? { allowedTools } : {}),
    ...(sessionId ? { resumeSessionId: sessionId } : {}),
    // A read that failed on a timeout or a 503 gets one more try before the
    // model sees it. By pattern, not by model: see eval/retry.
    retryJudge: patternRetryJudge,
    // End a run that keeps failing the same way. The repeat check always;
    // the model beside it when there is one, for the same failure in a
    // different form each time. See eval/stop.
    stopJudge: arenaJudge
      ? anyStopJudge(createRepeatStopJudge(), createStopJudge({ backend: arenaJudge }))
      : createRepeatStopJudge(),
    // Ask before Bash/Write/Edit, let the gate clear the easy ones, and send
    // whatever is left to the browser. The previous behaviour here was
    // `defaultMode: "allow"` — the web UI ran every tool call without asking
    // and without saying so, which is the one configuration the CLI does not
    // offer.
    permissions: {
      ...PermissionPresets.askDangerous(),
      // Wrapped rather than called a second time: the verdict is already
      // computed inside check(), and asking again would double the judge's
      // latency and cost on every tool call just to tell the browser about
      // it. Its whole effect otherwise is a prompt that does not appear.
      ...(gate
        ? {
            gate: async (request: PermissionRequest) => {
              const verdict = await gate(request);
              if (request.toolUseId) verdicts.set(request.toolUseId, verdict);
              send("gate_verdict", {
                id: request.toolUseId,
                action: verdict.action,
                probability: verdict.probability,
                reason: verdict.reason,
                judge: gateLabel,
                answers: verdict.answers,
                latencyMs: verdict.latencyMs,
                threshold: verdict.threshold,
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

          // Fail closed on silence, and on the run being stopped.
          const timer = setTimeout(() => settle("deny"), APPROVAL_TIMEOUT_MS);
          if (controller.signal.aborted) settle("deny");
          controller.signal.addEventListener("abort", () => settle("deny"), { once: true });

          pendingApprovals.set(id, settle);
          const verdict = request.toolUseId ? verdicts.get(request.toolUseId) : undefined;
          send("permission_request", {
            id,
            toolUseId: request.toolUseId,
            toolName: request.toolName,
            input: request.input,
            description: request.description,
            ...(verdict ? { gate: { ...verdict, judge: gateLabel } } : {}),
          });
        }),
    },
  });

  agent.on((event) => forward(event, send));

  try {
    await agent.run(message, { signal: controller.signal });
  } catch (err) {
    send("error", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    res.end();
  }
});

/** Agent event → the SSE event the browser already reads. */
function forward(event: AgentEvent, send: (event: string, data: unknown) => void): void {
  switch (event.type) {
    case "session":
      send("session", { sessionId: event.sessionId });
      break;
    case "text_delta":
    case "thinking_delta":
      send(event.type, { delta: event.delta });
      break;
    // The card appears when the model asks, not when the call starts, so
    // that the gate's verdict and any approval have a card to attach to.
    case "tool_request":
      send("tool_start", { id: event.toolUseId, name: event.toolName, input: event.input });
      break;
    case "tool_denied":
      send("tool_end", { id: event.toolUseId, name: event.toolName, error: event.reason, durationMs: 0 });
      break;
    case "tool_end":
      send("tool_end", {
        id: event.toolUseId,
        name: event.toolName,
        durationMs: event.durationMs,
        result: event.result.type === "success" ? event.result.output.slice(0, 500) : undefined,
        error: event.result.type === "error" ? event.result.message : undefined,
      });
      break;
    case "turn_start":
      send("turn_start", { turn: event.turn });
      break;
    case "turn_end":
      send("turn_end", { turn: event.turn, usage: webUsage(event.usage) });
      break;
    case "done":
      send("done", {
        sessionId: event.result.sessionId,
        turns: event.result.turns,
        stopReason: event.result.stopReason,
        usage: webUsage(event.result.usage),
      });
      break;
    case "stop_check":
      // Only a stop is news; a "keep going" every turn is not.
      if (event.verdict.stop) send("stopped", { reason: event.verdict.reason });
      break;
    case "tool_retry":
      send("retry_verdict", {
        id: event.toolUseId,
        retry: event.verdict.retry,
        probability: event.verdict.probability,
        reason: event.verdict.reason,
        error: event.error,
      });
      break;
    case "tool_start":
      break;
  }
}

function webUsage(u: { inputTokens: number; outputTokens: number; estimatedCostUsd: number }) {
  return { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cost: u.estimatedCostUsd };
}

const PORT = Number(process.env["PORT"] ?? 3001);
app.listen(PORT, "127.0.0.1", () => {
  console.log(`\n🚀 Agent API server running at http://127.0.0.1:${PORT} (this machine only)`);
  console.log(`   API Key: ${process.env["ANTHROPIC_API_KEY"] ? "✓ set" : "✗ not set (enter in UI)"}`);
  console.log(`   Tools: ${globalRegistry.names().join(", ")}`);
  console.log(`   Risk gate: ${gate ? gateLabel : "off"} — asks before Bash / Write / Edit\n`);
});
