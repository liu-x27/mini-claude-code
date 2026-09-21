import { useEffect, useRef } from "react";
import type { PendingApproval } from "../hooks/useChat";

/**
 * The question the gate would not answer.
 *
 * Deliberately shows the command as the thing being decided, not the tool
 * name: "Bash" is not a decision anyone can make, and `rm -rf dist` is. The
 * gate's own reasoning goes underneath, because the useful version of this
 * prompt tells you *why* it reached you — a call deferred at 0.21 deserves a
 * different glance from one deferred at 0.99.
 */
export function ApprovalCard({
  approval,
  onRespond,
}: {
  approval: PendingApproval;
  onRespond: (id: string, decision: "allow" | "deny" | "always-allow") => void;
}) {
  const allowRef = useRef<HTMLButtonElement>(null);

  // Focus deny-adjacent-but-not-destructive: the primary action gets focus so
  // Enter works, but Escape denies, so the fast reflex is the safe one.
  useEffect(() => {
    allowRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onRespond(approval.id, "deny");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [approval.id, onRespond]);

  const command =
    typeof approval.input["command"] === "string"
      ? (approval.input["command"] as string)
      : typeof approval.input["file_path"] === "string"
        ? (approval.input["file_path"] as string)
        : approval.description;

  const p = approval.gate?.probability;

  return (
    <div className="approval" role="alertdialog" aria-label="Tool call needs approval">
      <div className="approval-top">
        <span className="approval-chip">needs your approval</span>
        <span className="approval-tool">{approval.toolName}</span>
      </div>

      <pre className="approval-cmd">{command}</pre>

      {approval.gate && (
        <div className="approval-why">
          <span className="approval-why-label">{approval.gate.judge}</span>
          {p === undefined
            ? " could not produce a probability, so this came to you"
            : ` scored this ${p.toFixed(3)} — above the auto-approve threshold`}
        </div>
      )}

      <div className="approval-actions">
        <button
          ref={allowRef}
          type="button"
          className="approval-btn approval-allow"
          onClick={() => onRespond(approval.id, "allow")}
        >
          Allow once
        </button>
        <button
          type="button"
          className="approval-btn approval-always"
          onClick={() => onRespond(approval.id, "always-allow")}
        >
          Always allow {approval.toolName}
        </button>
        <button
          type="button"
          className="approval-btn approval-deny"
          onClick={() => onRespond(approval.id, "deny")}
        >
          Deny <kbd>Esc</kbd>
        </button>
      </div>

      <style>{`
        .approval { border:1px solid color-mix(in srgb, var(--yellow) 45%, transparent);
          background:linear-gradient(180deg, var(--yellow-bg), transparent 70%), var(--bg);
          border-radius:10px; padding:13px 14px 12px; margin-top:10px;
          box-shadow:0 1px 3px rgba(0,0,0,.06); animation:approvalIn .18s cubic-bezier(.2,.8,.3,1); }
        @keyframes approvalIn { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } }
        .approval-top { display:flex; align-items:center; gap:8px; margin-bottom:9px; }
        .approval-chip { font-size:10.5px; font-weight:700; letter-spacing:.06em; text-transform:uppercase;
          color:var(--yellow); }
        .approval-tool { font-family:"SF Mono","Fira Code",Consolas,monospace; font-size:11.5px;
          color:var(--text-3); padding:1px 6px; border:1px solid var(--border); border-radius:5px; }
        .approval-cmd { margin:0; background:var(--bg-code); border:1px solid var(--border); border-radius:7px;
          padding:10px 12px; font-family:"SF Mono","Fira Code",Consolas,monospace; font-size:12.5px;
          color:var(--text); white-space:pre-wrap; word-break:break-all; line-height:1.5; }
        .approval-why { margin-top:8px; font-size:11.5px; color:var(--text-3); line-height:1.5; }
        .approval-why-label { font-family:"SF Mono","Fira Code",Consolas,monospace; color:var(--text-2); }
        .approval-actions { display:flex; gap:7px; margin-top:11px; flex-wrap:wrap; }
        .approval-btn { font-size:12px; font-weight:600; padding:6px 12px; border-radius:6px; cursor:pointer;
          border:1px solid var(--border); background:var(--bg); color:var(--text-2); transition:.12s; }
        .approval-btn:hover { background:var(--bg-hover); }
        .approval-btn:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
        .approval-allow { background:var(--accent); border-color:var(--accent); color:#fff; }
        .approval-allow:hover { filter:brightness(1.07); background:var(--accent); }
        .approval-deny { margin-left:auto; }
        .approval-deny:hover { background:var(--red-bg); color:var(--red); border-color:var(--red); }
        .approval-btn kbd { font-family:inherit; font-size:10px; opacity:.6; margin-left:4px;
          border:1px solid currentColor; border-radius:3px; padding:0 3px; }
      `}</style>
    </div>
  );
}
