import type { Theme } from "../lib/theme";
import { ALL_MODELS } from "../lib/providers";
import { Icon, TOOL_ICONS } from "./Icon";

/* The frame around the transcript: top bar, sessions sidebar, empty state. */

export function TopBar({
  model,
  onModel,
  theme,
  onToggleTheme,
  onToggleSidebar,
  onOpenSettings,
  onNewChat,
  hasMessages,
  totals,
  busy,
}: {
  model: string;
  onModel: (m: string) => void;
  theme: Theme;
  onToggleTheme: () => void;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  onNewChat: () => void;
  hasMessages: boolean;
  totals: { tokens: number; cost: number };
  busy: boolean;
}) {
  const other = theme === "product" ? "Terminal" : "Product";
  return (
    <header className="topbar">
      <button type="button" className="icon-btn" onClick={onToggleSidebar} title="Sessions" aria-label="Toggle sessions">
        <Icon name="panel" />
      </button>
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">agent</span>
        <span className="brand-state" data-busy={busy || undefined}>
          {busy ? "running" : "idle"}
        </span>
      </div>

      <div className="topbar-spacer" />

      <label className="model-chip" title="Model">
        <span className="model-dot" aria-hidden="true" />
        <input
          value={model}
          onChange={(e) => onModel(e.target.value)}
          list="model-suggestions"
          aria-label="Model"
          spellCheck={false}
        />
        <datalist id="model-suggestions">
          {ALL_MODELS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>

      {totals.tokens > 0 && (
        <span className="meter" title="This conversation so far">
          <span>{totals.tokens.toLocaleString()} tok</span>
          <span className="meter-sep" aria-hidden="true" />
          <span>${totals.cost.toFixed(4)}</span>
        </span>
      )}

      <button type="button" className="icon-btn" onClick={onToggleTheme} title={`Switch to ${other} theme`} aria-label={`Switch to ${other} theme`}>
        <Icon name={theme === "product" ? "terminal" : "sparkle"} />
      </button>
      <button type="button" className="icon-btn" onClick={onOpenSettings} title="Settings" aria-label="Settings">
        <Icon name="settings" />
      </button>
      {hasMessages && (
        <button type="button" className="icon-btn" onClick={onNewChat} title="New chat" aria-label="New chat">
          <Icon name="plus" />
        </button>
      )}
    </header>
  );
}

export function Sidebar({ open, sessionId, onNewChat }: { open: boolean; sessionId: string | null; onNewChat: () => void }) {
  return (
    <aside className="sidebar" data-open={open || undefined} inert={!open}>
      <div className="sidebar-head">
        <span className="eyebrow">Sessions</span>
      </div>
      <button type="button" className="btn btn-quiet btn-block" onClick={onNewChat}>
        <Icon name="plus" size={15} />
        New chat
      </button>
      <div className="session-list">
        {sessionId ? (
          <div className="session is-active">
            <span className="session-label">Current</span>
            <code className="session-id">{sessionId.slice(0, 8)}</code>
          </div>
        ) : (
          <p className="sidebar-empty">Your first message starts a session.</p>
        )}
      </div>
      <p className="sidebar-foot">
        Saved to <code>~/.agent-app/sessions</code>
      </p>
    </aside>
  );
}

const SUGGESTIONS = [
  { title: "Map the repo", prompt: "List the files in this directory and say what each top-level folder is for." },
  { title: "Explain the architecture", prompt: "Read src/ and explain how the agent loop, tools and permissions fit together." },
  { title: "Find loose ends", prompt: "Search the code for TODO and FIXME comments and summarise them." },
  { title: "Measure something", prompt: "Count the lines in src/agent.ts with wc -l and report the number." },
];

export function EmptyState({ tools, onPick }: { tools: string[]; onPick: (prompt: string) => void }) {
  return (
    <section className="empty">
      <span className="empty-mark" aria-hidden="true" />
      <h1 className="empty-title">What should we work on?</h1>
      <p className="empty-sub">
        Tools run on this machine. Anything that writes or runs a command asks you first, unless the risk gate clears it.
      </p>
      <div className="empty-tools" aria-label="Tools available">
        {tools.map((t) => (
          <span key={t} className="tool-chip">
            <Icon name={TOOL_ICONS[t] ?? "tool"} size={13} />
            {t}
          </span>
        ))}
      </div>
      <div className="suggestions">
        {SUGGESTIONS.map((s, i) => (
          <button key={s.title} type="button" className="suggestion" onClick={() => onPick(s.prompt)}>
            <span className="suggestion-index">{i + 1}</span>
            <span className="suggestion-title">{s.title}</span>
            <span className="suggestion-prompt">{s.prompt}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
