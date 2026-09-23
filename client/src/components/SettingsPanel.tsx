import { useEffect, useRef } from "react";
import type { Provider } from "../hooks/useChat";
import { API_FORMATS, ALL_MODELS, PROVIDER_PRESETS } from "../lib/providers";
import { THEMES, type Theme } from "../lib/theme";
import { Icon, TOOL_ICONS } from "./Icon";

export interface Settings {
  apiKey: string;
  baseURL: string;
  provider: Provider;
  model: string;
}

/**
 * Settings as a slide-over, so opening them does not push the transcript
 * around. Stays mounted while closed for the transition, and is `inert`
 * then, so it cannot be tabbed into.
 */
export function SettingsPanel({
  open,
  onClose,
  settings,
  onChange,
  serverHasKey,
  tools,
  enabledTools,
  onToggleTool,
  theme,
  onTheme,
}: {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  serverHasKey: boolean;
  tools: string[];
  enabledTools: string[];
  onToggleTool: (name: string) => void;
  theme: Theme;
  onTheme: (t: Theme) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  return (
    <>
      <div className="scrim" data-open={open || undefined} onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer"
        data-open={open || undefined}
        inert={!open}
        role="dialog"
        aria-label="Settings"
        // Scoped to the panel, not the window: Escape on an open approval
        // card means "deny", and must not be swallowed here.
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="drawer-head">
          <h2>Settings</h2>
          <button ref={closeRef} type="button" className="icon-btn" onClick={onClose} aria-label="Close settings">
            <Icon name="close" />
          </button>
        </header>

        <div className="drawer-body">
          <section className="group">
            <h3 className="eyebrow">Appearance</h3>
            <div className="segmented" role="radiogroup" aria-label="Theme">
              {THEMES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  role="radio"
                  aria-checked={theme === t.value}
                  className="segment"
                  onClick={() => onTheme(t.value)}
                >
                  <span className="segment-label">{t.label}</span>
                  <span className="segment-hint">{t.hint}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="group">
            <h3 className="eyebrow">Provider</h3>
            <div className="preset-grid">
              {PROVIDER_PRESETS.map((p) => {
                const active = settings.baseURL === p.baseURL && settings.provider === p.provider;
                return (
                  <button
                    key={p.label}
                    type="button"
                    className="preset"
                    aria-pressed={active}
                    onClick={() => onChange({ baseURL: p.baseURL, provider: p.provider, model: p.models[0]! })}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="group">
            <h3 className="eyebrow">Connection</h3>
            <label className="field">
              <span className="field-label">API key</span>
              <input
                type="password"
                value={settings.apiKey}
                onChange={(e) => onChange({ apiKey: e.target.value })}
                placeholder={serverHasKey ? "Using the server's key" : "sk-…"}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span className="field-label">Base URL</span>
              <input
                value={settings.baseURL}
                onChange={(e) => onChange({ baseURL: e.target.value })}
                placeholder="Empty for api.anthropic.com"
                spellCheck={false}
              />
            </label>
            <div className="field">
              <span className="field-label">API format</span>
              <div className="segmented segmented-compact" role="radiogroup" aria-label="API format">
                {API_FORMATS.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    role="radio"
                    aria-checked={settings.provider === f.value}
                    className="segment"
                    onClick={() => onChange({ provider: f.value })}
                  >
                    <span className="segment-label">{f.label}</span>
                  </button>
                ))}
              </div>
              <p className="field-hint">
                For a custom base URL. MiniMax and a local Ollama serve both formats, and the URL alone does not say
                which.
              </p>
            </div>
            <label className="field">
              <span className="field-label">Model</span>
              <input
                value={settings.model}
                onChange={(e) => onChange({ model: e.target.value })}
                list="model-suggestions-settings"
                spellCheck={false}
              />
              <datalist id="model-suggestions-settings">
                {ALL_MODELS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
          </section>

          <section className="group">
            <h3 className="eyebrow">Tools</h3>
            <div className="chips">
              {tools.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="chip"
                  aria-pressed={enabledTools.includes(t)}
                  onClick={() => onToggleTool(t)}
                >
                  <Icon name={TOOL_ICONS[t] ?? "tool"} size={13} />
                  {t}
                </button>
              ))}
            </div>
            <p className="field-hint">A tool switched off here is not offered to the model at all.</p>
          </section>
        </div>
      </aside>
    </>
  );
}
