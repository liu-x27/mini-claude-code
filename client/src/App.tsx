import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApprovalCard } from "./components/ApprovalCard";
import { EmptyState, Sidebar, TopBar } from "./components/Chrome";
import { Composer, type ComposerHandle } from "./components/Composer";
import { Icon } from "./components/Icon";
import { Message } from "./components/Message";
import { type Settings, SettingsPanel } from "./components/SettingsPanel";
import { type Provider, useChat } from "./hooks/useChat";
import { DEFAULT_TOOLS } from "./lib/providers";
import { useTheme } from "./lib/theme";

function loadSettings(): Settings {
  const baseURL = localStorage.getItem("baseURL") ?? "";
  // Settings saved before the API format was a choice imply it the way the
  // presets do: a base URL meant an OpenAI-compatible endpoint.
  const saved = localStorage.getItem("provider");
  const provider: Provider = saved === "anthropic" || saved === "openai" ? saved : baseURL ? "openai" : "anthropic";
  return {
    apiKey: localStorage.getItem("apiKey") ?? "",
    baseURL,
    provider,
    model: localStorage.getItem("model") ?? "claude-opus-5",
  };
}

function saveSettings(s: Settings) {
  const put = (k: string, v: string) => (v ? localStorage.setItem(k, v) : localStorage.removeItem(k));
  put("apiKey", s.apiKey);
  put("baseURL", s.baseURL);
  localStorage.setItem("provider", s.provider);
  localStorage.setItem("model", s.model);
}

export default function App() {
  const [theme, setTheme, toggleTheme] = useTheme();
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [tools, setTools] = useState<string[]>(DEFAULT_TOOLS);
  const [enabledTools, setEnabledTools] = useState<string[]>(DEFAULT_TOOLS);
  const [serverHasKey, setServerHasKey] = useState(false);
  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const { state, send, stop, clear, respond } = useChat(
    settings.apiKey,
    settings.baseURL,
    settings.provider,
    settings.model,
    enabledTools,
  );

  useEffect(() => saveSettings(settings), [settings]);
  const updateSettings = useCallback((patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), []);

  // The server's own registry, rather than a list baked into the client.
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d: { hasApiKey?: boolean; tools?: string[] }) => {
        setServerHasKey(!!d.hasApiKey);
        if (Array.isArray(d.tools) && d.tools.length) {
          setTools(d.tools);
          setEnabledTools(d.tools);
        }
      })
      .catch(() => {});
  }, []);

  const toggleTool = useCallback(
    (name: string) => setEnabledTools((prev) => (prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name])),
    [],
  );

  const totals = useMemo(() => {
    let tokens = 0;
    let cost = 0;
    for (const m of state.messages) {
      if (!m.usage) continue;
      tokens += m.usage.inputTokens + m.usage.outputTokens;
      cost += m.usage.cost;
    }
    return { tokens, cost };
  }, [state.messages]);

  /* Follow the stream only while the reader is at the bottom: scrolling up
     to read an earlier tool call should not be undone by the next delta. */
  const threadRef = useRef<HTMLElement>(null);
  const pinned = useRef(true);
  const onScroll = useCallback(() => {
    const el = threadRef.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);
  useLayoutEffect(() => {
    const el = threadRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [state.messages, state.pendingApproval]);

  const composerRef = useRef<ComposerHandle>(null);
  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    pinned.current = true;
    send(text);
  }, [input, send]);

  const newChat = useCallback(() => {
    clear();
    composerRef.current?.focus();
  }, [clear]);

  const needsApiKey = !serverHasKey && !settings.apiKey;

  return (
    <div className="app" data-sidebar={sidebarOpen ? "open" : "closed"}>
      <Sidebar open={sidebarOpen} sessionId={state.sessionId} onNewChat={newChat} />

      <div className="main">
        <TopBar
          model={settings.model}
          onModel={(model) => updateSettings({ model })}
          theme={theme}
          onToggleTheme={toggleTheme}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          onOpenSettings={() => setSettingsOpen(true)}
          onNewChat={newChat}
          hasMessages={state.messages.length > 0}
          totals={totals}
          busy={state.isLoading}
        />

        {needsApiKey && (
          <div className="notice">
            <Icon name="key" size={15} />
            <span>Add an API key to start — or give the server one.</span>
            <button type="button" className="link" onClick={() => setSettingsOpen(true)}>
              Open settings
            </button>
          </div>
        )}

        <main className="thread" ref={threadRef} onScroll={onScroll}>
          <div className="thread-inner">
            {state.messages.length === 0 ? (
              <EmptyState
                tools={tools}
                onPick={(p) => {
                  setInput(p);
                  composerRef.current?.focus();
                }}
              />
            ) : (
              <>
                {state.messages.map((msg) => (
                  <Message
                    key={msg.id}
                    msg={msg}
                    modelLabel={settings.model}
                    waitingToolId={state.pendingApproval?.toolUseId}
                  />
                ))}
                {state.pendingApproval && <ApprovalCard approval={state.pendingApproval} onRespond={respond} />}
              </>
            )}
          </div>
        </main>

        <Composer
          ref={composerRef}
          value={input}
          onChange={setInput}
          onSend={handleSend}
          onStop={stop}
          busy={state.isLoading}
          disabled={needsApiKey}
          sessionId={state.sessionId}
        />
      </div>

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onChange={updateSettings}
        serverHasKey={serverHasKey}
        tools={tools}
        enabledTools={enabledTools}
        onToggleTool={toggleTool}
        theme={theme}
        onTheme={setTheme}
      />
    </div>
  );
}
