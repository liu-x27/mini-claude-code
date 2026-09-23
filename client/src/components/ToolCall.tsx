import { useState } from "react";
import type { ToolCall as ToolCallData } from "../hooks/useChat";
import { DEFAULT_THRESHOLD, fmtP, Ring, Scale } from "./Answers";
import { GateBadge } from "./GateBadge";
import { Icon, TOOL_ICONS } from "./Icon";

/** The argument a person would name the call by: the command, the path, the pattern. */
export function primaryArg(input: Record<string, unknown>): string {
  for (const key of ["command", "file_path", "pattern", "url", "path"]) {
    const v = input[key];
    if (typeof v === "string") return v;
  }
  const first = Object.values(input)[0];
  return typeof first === "string" ? first : JSON.stringify(input);
}

/** The server reports a call that never ran as an error with its reason. */
export function stateLabel(tc: ToolCallData, waiting: boolean): string {
  if (waiting) return "waiting for you";
  if (tc.status === "running") return "running";
  if (tc.status === "done") return `${tc.durationMs ?? 0}ms`;
  if (tc.error === "permission denied") return "denied";
  if (tc.error === "cancelled") return "cancelled";
  return "failed";
}

/**
 * One tool call in the transcript: a row that expands to its input and
 * output. It carries both a scale and a ring for the gate's verdict; each
 * theme shows one of them, or neither.
 */
export function ToolCall({
  tc,
  waiting = false,
  refNo,
}: {
  tc: ToolCallData;
  waiting?: boolean;
  refNo?: number | undefined;
}) {
  const [open, setOpen] = useState(false);
  const command = typeof tc.input["command"] === "string" ? (tc.input["command"] as string) : null;
  const failed = tc.status === "error";
  const threshold = tc.gate?.threshold ?? DEFAULT_THRESHOLD;

  return (
    <div
      className="tool"
      data-status={tc.status}
      data-open={open || undefined}
      data-waiting={waiting || undefined}
      data-gated={tc.gate ? tc.gate.action : undefined}
    >
      <button type="button" className="tool-row" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {tc.gate && <Ring p={tc.gate.probability} threshold={threshold} />}
        <span className="tool-node" aria-hidden="true">
          <Icon name={TOOL_ICONS[tc.name] ?? "tool"} size={14} />
        </span>
        <span className="tool-name">{tc.name}</span>
        <span className="tool-arg">{primaryArg(tc.input)}</span>
        {refNo !== undefined && <sup className="tool-ref">{refNo}</sup>}
        <GateBadge gate={tc.gate} approvedByUser={tc.approvedBy === "user"} />
        <span className="tool-state">
          {tc.status === "running" && !waiting && <span className="spinner" aria-hidden="true" />}
          {stateLabel(tc, waiting)}
        </span>
        <Icon name="chevron" size={14} className="tool-chevron" />
      </button>
      {tc.gate && tc.gate.probability !== undefined && <Scale gate={tc.gate} />}

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

/**
 * The same call as a margin note: a reference number, the command, and all
 * four answers as a table. Editorial shows these instead of inline rows.
 */
export function ToolNote({ tc, refNo, waiting }: { tc: ToolCallData; refNo: number; waiting: boolean }) {
  const g = tc.gate;
  const threshold = g?.threshold ?? DEFAULT_THRESHOLD;
  const verdict = waiting
    ? "Held"
    : g?.action === "allow"
      ? `Cleared · ${tc.durationMs ?? 0} ms`
      : tc.status === "done"
        ? `${tc.durationMs ?? 0} ms`
        : stateLabel(tc, waiting);
  const answers = [...(g?.answers ?? [])];
  return (
    <div className="note" data-held={waiting || g?.action === "ask" || undefined}>
      <h4>
        <sup>{refNo}</sup>
        {tc.name}
        <span className="note-verdict">{verdict}</span>
      </h4>
      <div className="note-cmd">{primaryArg(tc.input)}</div>
      {answers.length > 0 && (
        <table className="note-table">
          <tbody>
            {answers.map((a) => (
              <tr key={a.id} data-hot={a.probability >= threshold || undefined}>
                <td>{a.id}</td>
                <td>{a.probability.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {g && (
        <p className="note-foot">
          {g.probability === undefined
            ? "The judge gave no probability."
            : g.action === "allow"
              ? `All ${answers.length || "four"} under ${threshold.toFixed(2)} — ran without asking.`
              : `Worst ${fmtP(g.probability)}${g.latencyMs !== undefined ? ` · judged in ${g.latencyMs} ms` : ""}.`}
        </p>
      )}
    </div>
  );
}
