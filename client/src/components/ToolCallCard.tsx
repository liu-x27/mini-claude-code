import { useState } from "react";
import type { ToolCall } from "../hooks/useChat";

const ICONS: Record<string, string> = {
  Bash: "⚡", Read: "📄", Write: "✏️", Edit: "🔧",
  Glob: "🔍", Grep: "🔎", WebFetch: "🌐",
};

export function ToolCallCard({ tc }: { tc: ToolCall }) {
  const [open, setOpen] = useState(false);
  const icon = ICONS[tc.name] ?? "⚙️";
  const firstVal = Object.values(tc.input)[0];
  const preview = typeof firstVal === "string" ? firstVal.slice(0, 70) : JSON.stringify(tc.input).slice(0, 70);

  const statusColor =
    tc.status === "error" ? "var(--red)" :
    tc.status === "running" ? "var(--accent)" : "var(--green)";
  const statusBg =
    tc.status === "error" ? "var(--red-bg)" :
    tc.status === "running" ? "var(--accent-soft)" : "var(--green-bg)";

  return (
    <div className="tool-card">
      <button className="tool-header" onClick={() => setOpen(v => !v)}>
        <span className="tool-icon">{icon}</span>
        <span className="tool-name">{tc.name}</span>
        <span className="tool-preview">{preview}</span>
        <span className="tool-badge" style={{ background: statusBg, color: statusColor }}>
          {tc.status === "running" ? "running…" : tc.status === "error" ? "error" : `${tc.durationMs}ms`}
        </span>
        <span className="tool-chevron">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="tool-body">
          <div className="tool-label">Input</div>
          <pre className="tool-code">{JSON.stringify(tc.input, null, 2)}</pre>
          {(tc.result || tc.error) && (
            <>
              <div className="tool-label" style={{ marginTop: 10 }}>Output</div>
              <pre className="tool-code" style={{ color: tc.error ? "var(--red)" : undefined, borderColor: tc.error ? "var(--red)" : undefined }}>
                {tc.error ?? tc.result}
              </pre>
            </>
          )}
        </div>
      )}

      <style>{`
        .tool-card { border:1px solid var(--border); border-radius:8px; margin-top:8px; overflow:hidden; background:var(--bg); font-size:13px; animation:fadeIn 0.2s ease; }
        .tool-header { width:100%; display:flex; align-items:center; gap:8px; padding:9px 12px; background:none; border:none; cursor:pointer; color:var(--text-2); text-align:left; }
        .tool-header:hover { background:var(--bg-hover); }
        .tool-icon { font-size:14px; flex-shrink:0; }
        .tool-name { font-weight:600; color:var(--text); font-family:monospace; font-size:12.5px; flex-shrink:0; }
        .tool-preview { flex:1; color:var(--text-3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
        .tool-badge { font-size:11px; font-weight:600; padding:2px 8px; border-radius:20px; flex-shrink:0; }
        .tool-chevron { color:var(--text-3); font-size:10px; flex-shrink:0; }
        .tool-body { border-top:1px solid var(--border); padding:10px 12px; background:var(--bg-code); }
        .tool-label { font-size:10.5px; font-weight:700; color:var(--text-3); text-transform:uppercase; letter-spacing:.06em; margin-bottom:5px; }
        .tool-code { background:var(--bg); border:1px solid var(--border); border-radius:6px; padding:10px 12px; color:var(--text); font-size:12px; font-family:"SF Mono","Fira Code",Consolas,monospace; overflow:auto; max-height:220px; white-space:pre-wrap; word-break:break-all; line-height:1.55; margin:0; }
      `}</style>
    </div>
  );
}
