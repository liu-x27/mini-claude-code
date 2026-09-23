import { useState } from "react";
import type { ToolCall as ToolCallData } from "../hooks/useChat";
import { GateBadge } from "./GateBadge";
import { Icon, TOOL_ICONS } from "./Icon";

/** The argument a person would name the call by: the command, the path, the pattern. */
function primaryArg(input: Record<string, unknown>): string {
  for (const key of ["command", "file_path", "pattern", "url", "path"]) {
    const v = input[key];
    if (typeof v === "string") return v;
  }
  const first = Object.values(input)[0];
  return typeof first === "string" ? first : JSON.stringify(input);
}

/** The server reports a call that never ran as an error with its reason. */
function stateLabel(tc: ToolCallData, waiting: boolean): string {
  if (waiting) return "waiting for you";
  if (tc.status === "running") return "running";
  if (tc.status === "done") return `${tc.durationMs ?? 0}ms`;
  if (tc.error === "permission denied") return "denied";
  if (tc.error === "cancelled") return "cancelled";
  return "failed";
}

/**
 * One tool call, as a row that expands to its input and output.
 *
 * The markup is the same in both themes: product draws it as a step on a
 * timeline with the tool's icon, terminal as a line of a tree log. Both are
 * CSS over `.tool` and `data-status`.
 */
export function ToolCall({ tc, waiting = false }: { tc: ToolCallData; waiting?: boolean }) {
  const [open, setOpen] = useState(false);
  const command = typeof tc.input["command"] === "string" ? (tc.input["command"] as string) : null;
  const failed = tc.status === "error";

  return (
    <div className="tool" data-status={tc.status} data-open={open || undefined} data-waiting={waiting || undefined}>
      <button type="button" className="tool-row" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="tool-node" aria-hidden="true">
          <Icon name={TOOL_ICONS[tc.name] ?? "tool"} size={14} />
        </span>
        <span className="tool-name">{tc.name}</span>
        <span className="tool-arg">{primaryArg(tc.input)}</span>
        <GateBadge gate={tc.gate} approvedByUser={tc.approvedBy === "user"} />
        <span className="tool-state">
          {tc.status === "running" && !waiting && <span className="spinner" aria-hidden="true" />}
          {stateLabel(tc, waiting)}
        </span>
        <Icon name="chevron" size={14} className="tool-chevron" />
      </button>

      {open && (
        <div className="tool-detail">
          {command ? (
            <pre className="code">
              <span className="code-prompt">$ </span>
              {command}
            </pre>
          ) : (
            <>
              <div className="label">Input</div>
              <pre className="code">{JSON.stringify(tc.input, null, 2)}</pre>
            </>
          )}
          {(tc.result || tc.error) && (
            <>
              <div className="label">{failed ? "Error" : "Output"}</div>
              <pre className={failed ? "code is-error" : "code"}>{tc.error ?? tc.result}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
