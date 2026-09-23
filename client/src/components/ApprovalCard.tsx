import { useEffect, useRef } from "react";
import type { PendingApproval } from "../hooks/useChat";
import { Icon } from "./Icon";

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

  const p = approval.gate?.probability;

  return (
    <div className="approval" role="alertdialog" aria-label="Tool call needs approval">
      <div className="approval-top">
        <Icon name="shield" size={15} className="approval-icon" />
        <span className="approval-chip">Needs your approval</span>
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
        <button type="button" className="approval-btn approval-deny" onClick={() => onRespond(approval.id, "deny")}>
          Deny <kbd>Esc</kbd>
        </button>
      </div>
    </div>
  );
}
