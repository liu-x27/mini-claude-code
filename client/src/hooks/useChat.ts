import { useState, useRef, useCallback } from "react";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string | undefined;
  error?: string | undefined;
  durationMs?: number | undefined;
  status: "running" | "done" | "error";
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
}

export function useChat(apiKey: string, baseURL: string, model: string, allowedTools: string[]) {
  const [state, setState] = useState<ChatState>({
    messages: [],
    isLoading: false,
    sessionId: null,
    error: null,
  });
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
                      : tc
                  );
                  break;
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
    setState({ messages: [], isLoading: false, sessionId: null, error: null });
  }, []);

  return { state, send, stop, clear };
}
