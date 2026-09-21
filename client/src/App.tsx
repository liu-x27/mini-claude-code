import { useState, useRef, useEffect, useCallback } from "react";
import { useChat } from "./hooks/useChat";
import { MessageBubble } from "./components/MessageBubble";

const ALL_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch"];

const PROVIDER_PRESETS = [
  { label: "Anthropic", baseURL: "", models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"] },
  { label: "OpenAI", baseURL: "https://api.openai.com/v1", models: ["gpt-4o", "gpt-4o-mini", "o3-mini"] },
  { label: "DeepSeek", baseURL: "https://api.deepseek.com/v1", models: ["deepseek-chat", "deepseek-reasoner"] },
  { label: "Groq", baseURL: "https://api.groq.com/openai/v1", models: ["llama-3.3-70b-versatile", "mixtral-8x7b-32768"] },
  { label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", models: ["anthropic/claude-opus-5", "openai/gpt-4o", "google/gemini-2.0-flash-001"] },
];

const QUICK_PROMPTS = [
  "列出当前目录的文件结构",
  "分析 src/ 目录下的代码，告诉我项目架构",
  "帮我写一个 TypeScript 的 Hello World",
  "搜索代码中所有的 TODO 注释",
];

export default function App() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("apiKey") ?? "");
  const [baseURL, setBaseURL] = useState(() => localStorage.getItem("baseURL") ?? "");
  const [model, setModel] = useState(() => localStorage.getItem("model") ?? "claude-opus-5");
  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [enabledTools, setEnabledTools] = useState<string[]>(ALL_TOOLS);
  const [showSettings, setShowSettings] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(false);

  const { state, send, stop, clear } = useChat(apiKey, baseURL, model, enabledTools);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch("/api/health")
      .then(r => r.json())
      .then((d: { hasApiKey?: boolean }) => setHasApiKey(!!d.hasApiKey))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (apiKey) localStorage.setItem("apiKey", apiKey);
    else localStorage.removeItem("apiKey");
  }, [apiKey]);

  useEffect(() => {
    if (baseURL) localStorage.setItem("baseURL", baseURL);
    else localStorage.removeItem("baseURL");
  }, [baseURL]);

  useEffect(() => {
    localStorage.setItem("model", model);
  }, [model]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    send(text);
  }, [input, send]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const toggleTool = (name: string) => {
    setEnabledTools(prev =>
      prev.includes(name) ? prev.filter(t => t !== name) : [...prev, name]
    );
  };

  const needsApiKey = !hasApiKey && !apiKey;

  return (
    <div style={{ display: "flex", height: "100vh", background: "var(--bg)", overflow: "hidden" }}>

      {/* ── Sidebar ── */}
      <div style={{
        width: sidebarOpen ? 240 : 0,
        minWidth: sidebarOpen ? 240 : 0,
        overflow: "hidden",
        transition: "width 0.22s ease, min-width 0.22s ease",
        background: "var(--bg-sidebar)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
      }}>
        <div style={{ padding: "16px 14px 12px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
            Sessions
          </div>
          <button onClick={clear} style={newChatBtn}>
            + New chat
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
          {state.sessionId && (
            <div style={{
              padding: "8px 10px",
              borderRadius: 8,
              background: "var(--bg-active)",
              border: "1px solid var(--border-md)",
              fontSize: 12,
              color: "var(--text-2)",
              cursor: "default",
            }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: "var(--accent)", marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.05em" }}>Active</div>
              <div style={{ color: "var(--text-3)", fontFamily: "monospace", fontSize: 11.5 }}>
                {state.sessionId.slice(0, 8)}…
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Main ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>

        {/* Header */}
        <div style={{
          height: 50,
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          gap: 10,
          background: "var(--bg-sidebar)",
          flexShrink: 0,
        }}>
          <button onClick={() => setSidebarOpen(v => !v)} style={iconBtnStyle} title="Toggle sidebar">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="2" y="4" width="12" height="1.5" rx="0.75" fill="currentColor"/>
              <rect x="2" y="7.25" width="12" height="1.5" rx="0.75" fill="currentColor"/>
              <rect x="2" y="10.5" width="12" height="1.5" rx="0.75" fill="currentColor"/>
            </svg>
          </button>

          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <div style={{
              width: 26, height: 26, borderRadius: 8,
              background: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <circle cx="7" cy="7" r="5.5" stroke="white" strokeWidth="1.5"/>
                <circle cx="7" cy="7" r="2.5" fill="white"/>
              </svg>
            </div>
            <span style={{ fontWeight: 700, fontSize: 14.5, color: "var(--text)", letterSpacing: "-0.01em" }}>Agent</span>
          </div>

          <div style={{ flex: 1 }} />

          <input
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder="model"
            list="model-suggestions"
            style={{ ...selectStyle, width: 170 }}
          />
          <datalist id="model-suggestions">
            {PROVIDER_PRESETS.flatMap(p => p.models).map(m => <option key={m} value={m} />)}
          </datalist>

          <button onClick={() => setShowSettings(v => !v)} style={{ ...iconBtnStyle, color: showSettings ? "var(--accent)" : undefined }} title="Settings">
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
              <path d="M6.3 1.5a1.2 1.2 0 0 1 2.4 0 5.5 5.5 0 0 1 1.38.57 1.2 1.2 0 0 1 1.7-1.7 1.2 1.2 0 0 1 0 1.7 5.5 5.5 0 0 1 .57 1.38 1.2 1.2 0 0 1 0 2.4 5.5 5.5 0 0 1-.57 1.38 1.2 1.2 0 0 1-1.7 1.7 1.2 1.2 0 0 1-1.7 0 5.5 5.5 0 0 1-1.38.57 1.2 1.2 0 0 1-2.4 0 5.5 5.5 0 0 1-1.38-.57 1.2 1.2 0 0 1-1.7-1.7 1.2 1.2 0 0 1 0-1.7 5.5 5.5 0 0 1-.57-1.38 1.2 1.2 0 0 1 0-2.4 5.5 5.5 0 0 1 .57-1.38 1.2 1.2 0 0 1 1.7-1.7 1.2 1.2 0 0 1 1.7 0A5.5 5.5 0 0 1 6.3 1.5z" stroke="currentColor" strokeWidth="1.2"/>
              <circle cx="7.5" cy="7.5" r="1.8" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
          </button>

          {state.messages.length > 0 && (
            <button onClick={clear} style={iconBtnStyle} title="New chat">
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                <path d="M2 7.5h11M8.5 3 13 7.5 8.5 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          )}
        </div>

        {/* Settings panel */}
        {showSettings && (
          <div style={{
            background: "var(--bg-sidebar)",
            borderBottom: "1px solid var(--border)",
            padding: "16px 20px",
            display: "flex",
            flexDirection: "column",
            gap: 16,
            flexShrink: 0,
          }}>
            {/* Provider presets */}
            <div>
              <div style={labelStyle}>Provider</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {PROVIDER_PRESETS.map(p => {
                  const active = baseURL === p.baseURL;
                  return (
                    <button
                      key={p.label}
                      onClick={() => {
                        setBaseURL(p.baseURL);
                        setModel(p.models[0]!);
                      }}
                      style={{
                        padding: "4px 12px",
                        borderRadius: 20,
                        fontSize: 12,
                        fontWeight: 500,
                        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                        background: active ? "var(--accent-soft)" : "transparent",
                        color: active ? "var(--accent)" : "var(--text-2)",
                        cursor: "pointer",
                        transition: "all 0.12s",
                      }}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* API Key + Base URL + Model */}
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div>
                <div style={labelStyle}>API Key</div>
                <input
                  type="password"
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder={hasApiKey ? "Using server key" : "sk-..."}
                  style={{ ...textInputStyle, width: 200, fontFamily: "monospace", fontSize: 12 }}
                />
              </div>
              <div>
                <div style={labelStyle}>Base URL</div>
                <input
                  value={baseURL}
                  onChange={e => setBaseURL(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  style={{ ...textInputStyle, width: 260, fontSize: 12 }}
                />
              </div>
              <div>
                <div style={labelStyle}>Model</div>
                <input
                  value={model}
                  onChange={e => setModel(e.target.value)}
                  list="model-suggestions-settings"
                  placeholder="model name"
                  style={{ ...textInputStyle, width: 200, fontSize: 12 }}
                />
                <datalist id="model-suggestions-settings">
                  {PROVIDER_PRESETS.flatMap(p => p.models).map(m => <option key={m} value={m} />)}
                </datalist>
              </div>
            </div>

            {/* Tools */}
            <div>
              <div style={labelStyle}>Tools</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {ALL_TOOLS.map(t => (
                  <button
                    key={t}
                    onClick={() => toggleTool(t)}
                    style={{
                      padding: "3px 11px",
                      borderRadius: 20,
                      fontSize: 12,
                      fontWeight: 500,
                      border: `1px solid ${enabledTools.includes(t) ? "var(--accent)" : "var(--border)"}`,
                      background: enabledTools.includes(t) ? "var(--accent-soft)" : "transparent",
                      color: enabledTools.includes(t) ? "var(--accent)" : "var(--text-3)",
                      cursor: "pointer",
                      transition: "all 0.12s",
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* API key warning */}
        {needsApiKey && (
          <div style={{
            margin: "12px 20px 0",
            padding: "10px 14px",
            background: "var(--yellow-bg)",
            border: "1px solid rgba(154,104,0,0.2)",
            borderRadius: 8,
            fontSize: 13,
            color: "var(--yellow)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
          }}>
            ⚠️ 需要 API Key — 点击设置按钮配置
          </div>
        )}

        {/* Messages */}
        <div style={{ flex: 1, overflowY: "auto", padding: "32px 0" }}>
          <div style={{ maxWidth: 720, margin: "0 auto", padding: "0 24px" }}>
            {state.messages.length === 0 ? (
              <div style={{ textAlign: "center", paddingTop: 80 }}>
                <div style={{
                  width: 52, height: 52, borderRadius: 16,
                  background: "var(--accent)", margin: "0 auto 20px",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
                    <circle cx="13" cy="13" r="10" stroke="white" strokeWidth="2"/>
                    <circle cx="13" cy="13" r="4.5" fill="white"/>
                  </svg>
                </div>
                <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", marginBottom: 8, letterSpacing: "-0.02em" }}>
                  How can I help you?
                </div>
                <div style={{ color: "var(--text-3)", marginBottom: 36, fontSize: 14 }}>
                  AI Agent · 支持工具调用 · 流式输出
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
                  {QUICK_PROMPTS.map(p => (
                    <button
                      key={p}
                      onClick={() => { setInput(p); inputRef.current?.focus(); }}
                      style={quickPromptBtn}
                      onMouseEnter={e => {
                        e.currentTarget.style.borderColor = "var(--accent)";
                        e.currentTarget.style.color = "var(--text)";
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.borderColor = "var(--border)";
                        e.currentTarget.style.color = "var(--text-2)";
                      }}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              state.messages.map(msg => <MessageBubble key={msg.id} msg={msg} />)
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* Input bar */}
        <div style={{
          borderTop: "1px solid var(--border)",
          padding: "14px 24px 16px",
          background: "var(--bg)",
          flexShrink: 0,
        }}>
          <div style={{ maxWidth: 720, margin: "0 auto" }}>
            <div style={{
              display: "flex",
              gap: 0,
              alignItems: "flex-end",
              background: "var(--bg-input)",
              border: "1px solid var(--border-md)",
              borderRadius: 14,
              padding: "6px 6px 6px 16px",
              boxShadow: "var(--shadow-sm)",
              transition: "border-color 0.15s",
            }}
              onFocus={() => {}}
            >
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Message Agent…"
                rows={1}
                disabled={state.isLoading}
                style={{
                  flex: 1,
                  background: "none",
                  border: "none",
                  outline: "none",
                  resize: "none",
                  color: "var(--text)",
                  fontSize: 14.5,
                  lineHeight: 1.6,
                  minHeight: 36,
                  maxHeight: 160,
                  paddingTop: 6,
                  paddingBottom: 6,
                  overflow: "auto",
                  fontFamily: "inherit",
                }}
                onInput={e => {
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = Math.min(el.scrollHeight, 160) + "px";
                }}
              />
              <div style={{ display: "flex", gap: 4, alignItems: "flex-end", paddingBottom: 2 }}>
                {state.isLoading ? (
                  <button onClick={stop} style={stopBtnStyle}>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor"/>
                    </svg>
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!input.trim() || needsApiKey}
                    style={{
                      ...sendBtnStyle,
                      opacity: (!input.trim() || needsApiKey) ? 0.4 : 1,
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M7 11.5V2.5M3 6l4-4 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                )}
              </div>
            </div>
            {state.sessionId && (
              <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 6, textAlign: "center" }}>
                Session {state.sessionId.slice(0, 8)}…
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
        textarea::placeholder { color: var(--text-3); }
        input::placeholder { color: var(--text-3); }
        select option { background: var(--bg); color: var(--text); }
      `}</style>
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  padding: "6px",
  borderRadius: 7,
  color: "var(--text-2)",
  lineHeight: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const selectStyle: React.CSSProperties = {
  background: "var(--bg-hover)",
  border: "1px solid var(--border)",
  borderRadius: 7,
  color: "var(--text-2)",
  fontSize: 12,
  fontWeight: 500,
  padding: "4px 10px",
  cursor: "pointer",
  outline: "none",
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "var(--text-3)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 7,
};

const textInputStyle: React.CSSProperties = {
  background: "var(--bg-input)",
  border: "1px solid var(--border-md)",
  borderRadius: 8,
  color: "var(--text)",
  fontSize: 14,
  padding: "8px 12px",
  outline: "none",
};

const sendBtnStyle: React.CSSProperties = {
  width: 34,
  height: 34,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--accent)",
  border: "none",
  borderRadius: 9,
  color: "#fff",
  cursor: "pointer",
  transition: "opacity 0.12s, background 0.12s",
  flexShrink: 0,
};

const stopBtnStyle: React.CSSProperties = {
  width: 34,
  height: 34,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--red)",
  border: "none",
  borderRadius: 9,
  color: "#fff",
  cursor: "pointer",
  flexShrink: 0,
};

const newChatBtn: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  background: "var(--bg-active)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text-2)",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  textAlign: "left",
};

const quickPromptBtn: React.CSSProperties = {
  padding: "8px 16px",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 20,
  color: "var(--text-2)",
  cursor: "pointer",
  fontSize: 13,
  transition: "border-color 0.15s, color 0.15s",
};
