import type { CSSProperties } from "react";
import type { Message, ToolCall } from "../hooks/useChat";
import { DEFAULT_THRESHOLD, shortName } from "./Answers";
import { primaryArg } from "./ToolCall";

/** Every call the gate was asked about, in order. */
export function gatedCalls(messages: Message[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const m of messages) for (const tc of m.toolCalls ?? []) if (tc.gate) calls.push(tc);
  return calls;
}

export function medianLatency(calls: ToolCall[]): number | undefined {
  const ms = calls.map((c) => c.gate?.latencyMs).filter((x): x is number => typeof x === "number");
  return ms.length ? [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)] : undefined;
}

/**
 * Every decision the risk gate made in this conversation, newest first,
 * with the numbers behind each one. Instrument's right-hand rail.
 *
 * Only calls the gate was asked about appear — a call the static rules
 * allowed or denied never reached it — and the latency is the judge's own,
 * measured on the server around the backend call.
 */
export function DecisionRail({ messages, judge, waitingId }: { messages: Message[]; judge: string | undefined; waitingId: string | undefined }) {
  const calls = gatedCalls(messages);
  const latencies = calls.map((c) => c.gate?.latencyMs).filter((x): x is number => typeof x === "number");
  const median = medianLatency(calls);
  const cleared = calls.filter((c) => c.gate?.action === "allow").length;
  const held = calls.filter((c) => c.gate?.action === "ask").length;
  const recent = latencies.slice(-12);
  const scaleMax = Math.max(120, ...recent);
  const threshold = calls.find((c) => c.gate?.threshold !== undefined)?.gate?.threshold ?? DEFAULT_THRESHOLD;

  return (
    <aside className="rail-panel" aria-label="Risk gate decisions">
      <header className="rail-head">
        <h2>Risk gate</h2>
        {judge && <span className="pill">{judge}</span>}
      </header>
      <div className="kpis">
        <div className="kpi">
          <b>
            {median ?? "—"}
            {median !== undefined && <small>ms</small>}
          </b>
          <span>median</span>
        </div>
        <div className="kpi" data-tone="ok">
          <b>{cleared}</b>
          <span>cleared</span>
        </div>
        <div className="kpi" data-tone="ask">
          <b>{held}</b>
          <span>held</span>
        </div>
      </div>
      <div className="spark">
        <div className="spark-label">
          <span>Decision latency</span>
          <span>{recent.length ? `last ${recent.length} · ${Math.min(...recent)}–${Math.max(...recent)} ms` : "no decisions yet"}</span>
        </div>
        <div className="spark-bars">
          {/* Always twelve slots, filled from the right, so two decisions
              read as two bars on a baseline rather than two slabs. */}
          {Array.from({ length: 12 - recent.length }, (_, i) => (
            <i key={`idle-${i}`} className="idle" />
          ))}
          {recent.map((ms, i) => (
            <i
              key={i}
              title={`${ms} ms`}
              style={{ "--h": ms / scaleMax } as CSSProperties}
              data-last={i === recent.length - 1 || undefined}
            />
          ))}
        </div>
      </div>
      <div className="decisions">
        {calls.length === 0 && (
          <p className="rail-empty">
            Bash, Write and Edit calls are scored here before they run. Below {threshold.toFixed(2)} on every question,
            they run; otherwise they come to you.
          </p>
        )}
        {[...calls].reverse().map((c) => {
          const g = c.gate!;
          const live = c.id === waitingId;
          const verdict = g.action === "allow" ? "cleared" : g.action === "deny" ? "blocked" : "held";
          return (
            <div key={c.id} className="decision" data-live={live || undefined} data-verdict={verdict}>
              <div className="decision-head">
                <span className={`verdict verdict-${verdict}`}>{verdict}</span>
                <span className="decision-cmd">{primaryArg(c.input)}</span>
                <span className="decision-ms">{g.latencyMs !== undefined ? `${g.latencyMs} ms` : ""}</span>
              </div>
              {g.answers && (
                <div className="cells">
                  {g.answers.map((a) => (
                    <div key={a.id} className="cell" data-hot={a.probability >= threshold || undefined}>
                      <em>{shortName(a.id)}</em>
                      <b>{a.probability.toFixed(3).replace(/^0/, "")}</b>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="rail-foot">
        Auto-allow below <b>{threshold.toFixed(2)}</b> on every question. A static <b>deny</b> is never asked.
      </p>
    </aside>
  );
}
