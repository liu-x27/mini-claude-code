import { useEffect, useRef } from "react";
import type { PendingApproval } from "../hooks/useChat";
import { AnswerRows, DEFAULT_THRESHOLD, fmtP, Ring, whyHeld, worst } from "./Answers";
import { Icon } from "./Icon";

/**
 * The question the gate would not answer.
 *
 * Deliberately shows the command as the thing being decided, not the tool
 * name: "Bash" is not a decision anyone can make, and `rm -rf dist` is. The
 * gate's own numbers go with it, because the useful version of this prompt
 * tells you *why* it reached you — a call held at 0.21 deserves a different
 * glance from one held at 0.998.
 */
export function ApprovalCard({
  approval,
  onRespond,
  refNo,
}: {
  approval: PendingApproval;
  onRespond: (id: string, decision: "allow" | "deny" | "always-allow") => void;
  refNo?: number | undefined;
}) {
  const allowRef = useRef<HTMLButtonElement>(null);

  // The primary action gets focus so Enter works, but Escape denies, so the
  // fast reflex is the safe one.
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

  const gate = approval.gate;
  const top = worst(gate);
  const threshold = gate?.threshold ?? DEFAULT_THRESHOLD;

  return (
    <div className="approval" data-tool={approval.toolName} role="alertdialog" aria-label="Tool call needs approval">
      <div className="approval-head">
        <Icon name="shield" size={16} className="approval-icon" />
        <span className="approval-kicker">
          Held for your decision
          {refNo !== undefined && <sup>{refNo}</sup>}
        </span>
        <span className="approval-tool">{approval.toolName}</span>
      </div>

      <div className="approval-body">
        <Ring p={gate?.probability} threshold={threshold} size="lg" />
        <div className="approval-main">
          <pre className="approval-cmd">{command}</pre>
          <p className="approval-why">{whyHeld(gate)}</p>
        </div>
        <div className="approval-score">
          <span className="approval-number">{fmtP(gate?.probability)}</span>
          {top && <span className="approval-unit">P({top.id})</span>}
        </div>
      </div>

      {gate && <AnswerRows gate={gate} />}

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
        <button type="button" className="approval-btn approval-deny" onClick={() => onRespond(approval.id, "deny")}>
          Deny <kbd>Esc</kbd>
        </button>
      </div>
      {gate && (
        <p className="approval-judge">
          {gate.judge}
          {gate.latencyMs !== undefined && ` · ${gate.latencyMs} ms`} · auto-allow below {threshold.toFixed(2)}
        </p>
      )}
    </div>
  );
}
