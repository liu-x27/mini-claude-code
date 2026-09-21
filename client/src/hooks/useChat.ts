import { useState, useRef, useCallback } from "react";

/** What the risk gate decided about a tool call, when it decided. */
export interface GateVerdict {
  action: "allow" | "ask" | "deny";
  /** undefined when the judge never produced a usable answer. */
  probability?: number | undefined;
  reason: string;
  judge: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string | undefined;
  error?: string | undefined;
  durationMs?: number | undefined;
  status: "running" | "done" | "error";
  gate?: GateVerdict | undefined;
  /** Set once a human answered a call the gate deferred. */
  approvedBy?: "user" | undefined;
}

/** A tool call parked on the server, waiting for the user to decide. */
export interface PendingApproval {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  description: string;
  gate?: GateVerdict | undefined;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number; cost: number };
  isStreaming?: boolean;
  error?: string;
}

export interface ChatState {
  messages: Message[];
  isLoading: boolean;
  sessionId: string | null;
  error: string | null;
  /** At most one at a time: the server asks about tool calls sequentially. */
  pendingApproval: PendingApproval | null;
}

export function useChat(apiKey: string, baseURL: string, model: string, allowedTools: string[]) {
  const [state, setState] = useState<ChatState>({
    messages: [],
    isLoading: false,
    sessionId: null,
    error: null,
    pendingApproval: null,
  });
  /**
   * The gate's last verdict, held until the matching permission_request
   * arrives. The server sends the verdict first, so a deferral can show the
   * probability it was deferred on rather than an unexplained prompt.
   */
  const lastVerdictRef = useRef<GateVerdict | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || state.isLoading) return;

      // Add user message
      const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: text };
      const assistantMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        toolCalls: [],
        isStreaming: true,
      };

      setState((s) => ({
        ...s,
        messages: [...s.messages, userMsg, assistantMsg],
        isLoading: true,
        error: null,
      }));

      abortRef.current = new AbortController();

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            sessionId: state.sessionId,
            apiKey: apiKey || undefined,
            baseURL: baseURL || undefined,
            model,
            allowedTools: allowedTools.length ? allowedTools : undefined,
          }),
          signal: abortRef.current.signal,
        });

        if (!res.ok) {
          const err = await res.json() as { error?: string };
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";

          for (const part of parts) {
            const lines = part.trim().split("\n");
            let eventType = "message";
            let dataStr = "";
            for (const line of lines) {
              if (line.startsWith("event: ")) eventType = line.slice(7);
              if (line.startsWith("data: ")) dataStr = line.slice(6);
            }
            if (!dataStr) continue;

            let data: Record<string, unknown>;
            try { data = JSON.parse(dataStr); } catch { continue; }

            setState((s) => {
              const msgs = [...s.messages];
              const last = { ...msgs[msgs.length - 1]! };

              switch (eventType) {
                case "session":
                  return { ...s, sessionId: data["sessionId"] as string };

                case "text_delta":
                  last.content += data["delta"] as string;
                  break;

                case "thinking_delta":
                  last.thinking = (last.thinking ?? "") + (data["delta"] as string);
                  break;

                case "tool_start": {
                  const tc: ToolCall = {
                    id: data["id"] as string,
                    name: data["name"] as string,
                    input: data["input"] as Record<string, unknown>,
                    status: "running",
                  };
                  last.toolCalls = [...(last.toolCalls ?? []), tc];
                  break;
                }

                case "gate_verdict": {
                  const verdict: GateVerdict = {
                    action: data["action"] as GateVerdict["action"],
                    probability: data["probability"] as number | undefined,
                    reason: data["reason"] as string,
                    judge: data["judge"] as string,
                  };
                  lastVerdictRef.current = verdict;
                  last.toolCalls = (last.toolCalls ?? []).map((tc) =>
                    tc.id === (data["id"] as string) ? { ...tc, gate: verdict } : tc,
                  );
                  break;
                }

                case "permission_request": {
                  msgs[msgs.length - 1] = last;
                  return {
                    ...s,
                    messages: msgs,
                    pendingApproval: {
                      id: data["id"] as string,
                      toolName: data["toolName"] as string,
                      input: data["input"] as Record<string, unknown>,
                      description: data["description"] as string,
                      gate: lastVerdictRef.current ?? undefined,
                    },
                  };
                }

                case "tool_end": {
                  last.toolCalls = (last.toolCalls ?? []).map((tc) =>
                    tc.id === (data["id"] as string)
                      ? {
                          ...tc,
                          result: data["result"] as string | undefined,
                          error: data["error"] as string | undefined,
                          durationMs: data["durationMs"] as number,
                          status: data["error"] ? "error" : "done",
                        }
                      : tc,
                  );
                  msgs[msgs.length - 1] = last;
                  // The prompt for this call cannot still be open once the
                  // call has finished — it was answered, or it timed out.
                  return s.pendingApproval ? { ...s, messages: msgs, pendingApproval: null } : { ...s, messages: msgs };
                }

                case "done":
                  last.isStreaming = false;
                  last.usage = {
                    inputTokens: (data["usage"] as { inputTokens: number })?.inputTokens ?? 0,
                    outputTokens: (data["usage"] as { outputTokens: number })?.outputTokens ?? 0,
                    cost: (data["usage"] as { cost: number })?.cost ?? 0,
                  };
                  msgs[msgs.length - 1] = last;
                  return { ...s, messages: msgs, isLoading: false };

                case "error":
                  last.error = data["message"] as string;
                  last.isStreaming = false;
                  msgs[msgs.length - 1] = last;
                  return { ...s, messages: msgs, isLoading: false, error: data["message"] as string };
              }

              msgs[msgs.length - 1] = last;
              return { ...s, messages: msgs };
            });
          }
        }
      } catch (err: unknown) {
        if ((err as Error).name === "AbortError") return;
        setState((s) => ({
          ...s,
          isLoading: false,
          error: String(err),
          messages: s.messages.map((m, i) =>
            i === s.messages.length - 1 ? { ...m, isStreaming: false, error: String(err) } : m
          ),
        }));
      }
    },
    [state.isLoading, state.sessionId, apiKey, baseURL, model, allowedTools]
  );

  /**
   * Answer a parked tool call.
   *
   * Clears the card immediately rather than waiting for the POST: the server
   * has already committed to a decision by the time it replies, and leaving
   * the buttons live invites a second click that would 404.
   */
  const respond = useCallback(
    async (id: string, decision: "allow" | "deny" | "always-allow" | "always-deny") => {
      setState((s) => ({
        ...s,
        pendingApproval: null,
        messages: s.messages.map((m, i) =>
          i === s.messages.length - 1
            ? {
                ...m,
                toolCalls: (m.toolCalls ?? []).map((tc) =>
                  tc.status === "running" && decision.endsWith("allow")
                    ? { ...tc, approvedBy: "user" as const }
                    : tc,
                ),
              }
            : m,
        ),
      }));

      try {
        await fetch("/api/permission", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, decision }),
        });
      } catch {
        // The stream carries the real outcome; a failed POST just means the
        // call will time out and fail closed, which the tool_end event shows.
      }
    },
    [],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setState((s) => ({
      ...s,
      isLoading: false,
      messages: s.messages.map((m, i) =>
        i === s.messages.length - 1 ? { ...m, isStreaming: false } : m
      ),
    }));
  }, []);

  const clear = useCallback(() => {
    setState({
      messages: [],
      isLoading: false,
      sessionId: null,
      error: null,
      pendingApproval: null,
    });
  }, []);

  return { state, send, stop, clear, respond };
}
