import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Composer, type ComposerHandle } from "./components/Composer";
import { DecisionRail, gatedCalls, medianLatency } from "./components/DecisionRail";
import { Icon } from "./components/Icon";
import { Arena } from "./components/Arena";
import { FRAMES, type View } from "./components/Layouts";
import { Sessions } from "./components/Sessions";
import { type Settings, SettingsPanel } from "./components/SettingsPanel";
import { EmptyState, Thread } from "./components/Thread";
import { type Provider, useChat } from "./hooks/useChat";
import { useSnakeArena } from "./hooks/useSnakeArena";
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
  const [theme, setTheme, cycleTheme] = useTheme();
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [tools, setTools] = useState<string[]>(DEFAULT_TOOLS);
  const [enabledTools, setEnabledTools] = useState<string[]>(DEFAULT_TOOLS);
  const [serverHasKey, setServerHasKey] = useState(false);
  const [serverJudge, setServerJudge] = useState<string | undefined>();
  const [input, setInput] = useState("");
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [serverChoice, setServerChoice] = useState<string | undefined>();
  // The arena has an address, so it can be linked to and reloaded into.
  const [view, setView] = useState<View>(() => (location.hash === "#arena" ? "arena" : "chat"));
  useEffect(() => {
    const onHash = () => setView(location.hash === "#arena" ? "arena" : "chat");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const changeView = useCallback((v: View) => {
    setView(v);
    history.replaceState(null, "", v === "arena" ? "#arena" : location.pathname + location.search);
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const arena = useSnakeArena(serverChoice);
  // A game left running in the background would keep the judge busy, and it
  // is the same model the risk gate is waiting on.
  const pauseArena = arena.setRunning;
  useEffect(() => {
    if (view !== "arena") pauseArena(false);
  }, [view, pauseArena]);

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
      .then((d: { hasApiKey?: boolean; tools?: string[]; judge?: string | null; choice?: string | null }) => {
        setServerHasKey(!!d.hasApiKey);
        if (typeof d.judge === "string") setServerJudge(d.judge);
        if (typeof d.choice === "string") setServerChoice(d.choice);
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

  const calls = useMemo(() => gatedCalls(state.messages), [state.messages]);
  const judge = serverJudge ?? calls[0]?.gate?.judge;

  /* Follow the stream only while the reader is at the bottom: scrolling up
     to read an earlier tool call should not be undone by the next delta.
     A theme switch mounts a new frame, so it counts as a change too. */
  const threadRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const onScroll = useCallback(() => {
    const el = threadRef.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);
  useLayoutEffect(() => {
    const el = threadRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [state.messages, state.pendingApproval, theme, view]);

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
  const Frame = FRAMES[theme];

  return (
    <div className="app">
      <Frame
        view={view}
        onView={changeView}
        arena={<Arena game={arena} judge={serverChoice} />}
        theme={theme}
        onCycleTheme={cycleTheme}
        model={settings.model}
        onModel={(model) => updateSettings({ model })}
        totals={totals}
        busy={state.isLoading}
        sessionId={state.sessionId}
        judge={judge}
        medianMs={medianLatency(calls)}
        turns={state.messages.filter((m) => m.role === "user").length}
        hasMessages={state.messages.length > 0}
        onToggleSessions={() => setSessionsOpen((v) => !v)}
        onOpenSettings={() => setSettingsOpen(true)}
        onNewChat={newChat}
        threadRef={threadRef}
        onScroll={onScroll}
        notice={
          needsApiKey && (
            <div className="notice">
              <Icon name="key" size={15} />
              <span>Add an API key to start — or give the server one.</span>
              <button type="button" className="link" onClick={() => setSettingsOpen(true)}>
                Open settings
              </button>
            </div>
          )
        }
        thread={
          state.messages.length === 0 ? (
            <EmptyState
              tools={tools}
              onPick={(p) => {
                setInput(p);
                composerRef.current?.focus();
              }}
            />
          ) : (
            <Thread messages={state.messages} modelLabel={settings.model} pending={state.pendingApproval} onRespond={respond} />
          )
        }
        composer={
          <Composer
            ref={composerRef}
            value={input}
            onChange={setInput}
            onSend={handleSend}
            onStop={stop}
            busy={state.isLoading}
            disabled={needsApiKey}
          />
        }
        rail={<DecisionRail messages={state.messages} judge={judge} waitingId={state.pendingApproval?.toolUseId} />}
      />

      <Sessions open={sessionsOpen} onClose={() => setSessionsOpen(false)} sessionId={state.sessionId} onNewChat={newChat} />
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
