import type { ReactNode, RefObject, UIEventHandler } from "react";
import { ALL_MODELS } from "../lib/providers";
import { nextTheme, THEMES, type Theme } from "../lib/theme";
import { Icon } from "./Icon";

/**
 * The three frames. Each arranges the same parts — transcript, composer,
 * notice, and for Instrument the decision rail — in its own way; none of
 * them owns any state.
 */
export interface FrameProps {
  theme: Theme;
  onCycleTheme: () => void;
  model: string;
  onModel: (m: string) => void;
  totals: { tokens: number; cost: number };
  busy: boolean;
  sessionId: string | null;
  judge: string | undefined;
  medianMs: number | undefined;
  turns: number;
  hasMessages: boolean;
  onToggleSessions: () => void;
  onOpenSettings: () => void;
  onNewChat: () => void;
  notice: ReactNode;
  thread: ReactNode;
  threadRef: RefObject<HTMLDivElement | null>;
  onScroll: UIEventHandler<HTMLDivElement>;
  composer: ReactNode;
  rail: ReactNode;
}

const themeLabel = (t: Theme) => THEMES.find((x) => x.value === t)!.label;

function ModelInput({ model, onModel, id }: { model: string; onModel: (m: string) => void; id: string }) {
  return (
    <>
      <input
        className="model-input"
        value={model}
        onChange={(e) => onModel(e.target.value)}
        list={id}
        aria-label="Model"
        spellCheck={false}
      />
      <datalist id={id}>
        {ALL_MODELS.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </>
  );
}

function ThemeButton({ theme, onCycle, text }: { theme: Theme; onCycle: () => void; text?: boolean }) {
  const next = themeLabel(nextTheme(theme));
  return (
    <button type="button" className={text ? "text-btn" : "icon-btn"} onClick={onCycle} title={`Switch to ${next}`} aria-label={`Switch to ${next} theme`}>
      {text ? <>Theme · {themeLabel(theme)}</> : <Icon name="sparkle" />}
    </button>
  );
}

const Thread = ({ p }: { p: FrameProps }) => (
  <div className="thread" ref={p.threadRef} onScroll={p.onScroll}>
    <div className="thread-inner">{p.thread}</div>
  </div>
);

/* ------------------------------------------------------------ Instrument */

export function InstrumentFrame(p: FrameProps) {
  return (
    <div className="frame">
      <nav className="nav-rail" aria-label="Navigation">
        <span className="brand-mark" aria-hidden="true" />
        <button type="button" className="icon-btn is-on" title="Transcript" aria-label="Transcript" aria-current="page">
          <Icon name="chat" />
        </button>
        <button type="button" className="icon-btn" onClick={p.onToggleSessions} title="Sessions" aria-label="Toggle sessions">
          <Icon name="panel" />
        </button>
        <ThemeButton theme={p.theme} onCycle={p.onCycleTheme} />
        <span className="grow" />
        <button type="button" className="icon-btn" onClick={p.onOpenSettings} title="Settings" aria-label="Settings">
          <Icon name="settings" />
        </button>
      </nav>
      <main className="center">
        <header className="topbar">
          <div className="crumb">
            agent<span>/</span>
            {p.sessionId ? `session ${p.sessionId.slice(0, 8)}` : "new session"}
          </div>
          <span className="grow" />
          <label className="pill model-pill" data-busy={p.busy || undefined}>
            <span className="dot" aria-hidden="true" />
            <ModelInput model={p.model} onModel={p.onModel} id="models-i" />
          </label>
          {p.totals.tokens > 0 && (
            <span className="pill">
              {p.totals.tokens.toLocaleString()} tok · ${p.totals.cost.toFixed(4)}
            </span>
          )}
          {p.hasMessages && (
            <button type="button" className="icon-btn" onClick={p.onNewChat} title="New chat" aria-label="New chat">
              <Icon name="plus" />
            </button>
          )}
        </header>
        {p.notice}
        <Thread p={p} />
        {p.composer}
      </main>
      {p.rail}
    </div>
  );
}

/* ------------------------------------------------------------- Editorial */

export function EditorialFrame(p: FrameProps) {
  const today = new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return (
    <div className="frame">
      <div className="page">
        <header className="mast">
          <h1>
            Agent<em>.</em>
          </h1>
          <dl className="mast-meta">
            <div>
              <dt>Model</dt>
              <dd>
                <ModelInput model={p.model} onModel={p.onModel} id="models-e" />
              </dd>
            </div>
            <div>
              <dt>Gate</dt>
              <dd>{p.judge ?? "—"}</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>{p.sessionId ? p.sessionId.slice(0, 8) : "new"}</dd>
            </div>
            <div>
              <dd>${p.totals.cost.toFixed(4)}</dd>
            </div>
          </dl>
        </header>
        <nav className="subnav">
          <button type="button" className="text-btn is-on" aria-current="page">
            Transcript
          </button>
          <button type="button" className="text-btn" onClick={p.onToggleSessions}>
            Sessions
          </button>
          <button type="button" className="text-btn" onClick={p.onOpenSettings}>
            Settings
          </button>
          <span className="grow" />
          <span className="subnav-note">
            {today} · {p.turns} {p.turns === 1 ? "turn" : "turns"}
          </span>
          <ThemeButton theme={p.theme} onCycle={p.onCycleTheme} text />
          {p.hasMessages && (
            <button type="button" className="text-btn" onClick={p.onNewChat}>
              New
            </button>
          )}
        </nav>
        {p.notice}
        <Thread p={p} />
        {p.composer}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Aurora */

export function AuroraFrame(p: FrameProps) {
  return (
    <div className="frame">
      <div className="aurora" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="grain" aria-hidden="true" />
      <div className="shell">
        <header className="bar glass">
          <span className="orb" aria-hidden="true" />
          <h1>agent</h1>
          <span className="grow" />
          <label className="chip" data-busy={p.busy || undefined}>
            <span className="live" aria-hidden="true" />
            <ModelInput model={p.model} onModel={p.onModel} id="models-a" />
          </label>
          {p.judge && (
            <span className="chip">
              gate · {p.judge.replace(/^llm:/, "")}
              {p.medianMs !== undefined && ` · ${p.medianMs}ms`}
            </span>
          )}
          {p.totals.tokens > 0 && <span className="chip">${p.totals.cost.toFixed(4)}</span>}
          <button type="button" className="icon-btn" onClick={p.onToggleSessions} title="Sessions" aria-label="Toggle sessions">
            <Icon name="panel" />
          </button>
          <ThemeButton theme={p.theme} onCycle={p.onCycleTheme} />
          <button type="button" className="icon-btn" onClick={p.onOpenSettings} title="Settings" aria-label="Settings">
            <Icon name="settings" />
          </button>
          {p.hasMessages && (
            <button type="button" className="icon-btn" onClick={p.onNewChat} title="New chat" aria-label="New chat">
              <Icon name="plus" />
            </button>
          )}
        </header>
        {p.notice}
        <Thread p={p} />
        {p.composer}
      </div>
    </div>
  );
}

export const FRAMES: Record<Theme, (p: FrameProps) => ReactNode> = {
  instrument: InstrumentFrame,
  editorial: EditorialFrame,
  aurora: AuroraFrame,
};
