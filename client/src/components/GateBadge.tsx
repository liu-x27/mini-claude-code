import type { GateVerdict } from "../hooks/useChat";

/**
 * What the risk gate did to one tool call.
 *
 * Worth its own pill because the gate's entire effect is a prompt that does
 * not appear, and an absence is not something a user can notice. Showing the
 * probability it cleared on is also the only way anyone calibrates trust in
 * it: "auto 0.04" reads very differently from "auto 0.19" against a
 * threshold of 0.2.
 */
export function GateBadge({
  gate,
  approvedByUser,
}: {
  gate?: GateVerdict | undefined;
  approvedByUser?: boolean | undefined;
}) {
  if (!gate) return null;

  const p = gate.probability;
  // Three decimals, matching the approval card and the CLI log. Two rounds
  // 0.995 to "1.00", which claims a certainty nothing measured and disagrees
  // with the number shown right underneath it on the card.
  const shown = p === undefined ? "—" : p.toFixed(3);

  // Three states worth distinguishing, and they are not the same as the
  // gate's three actions: a deferral the user then approved is a different
  // outcome from one still waiting.
  const [label, title, tone] = approvedByUser
    ? [`you approved · ${shown}`, `${gate.judge}: ${gate.reason}`, "user" as const]
    : gate.action === "allow"
      ? [`auto ${shown}`, `${gate.judge} cleared this: ${gate.reason}`, "auto" as const]
      : gate.action === "deny"
        ? [`blocked ${shown}`, `${gate.judge}: ${gate.reason}`, "deny" as const]
        : [`asked · ${shown}`, `${gate.judge} deferred: ${gate.reason}`, "ask" as const];

  return (
    <span className={`gate-badge gate-${tone}`} title={title}>
      <span className="gate-dot" />
      {label}
      <style>{`
        .gate-badge { display:inline-flex; align-items:center; gap:5px; font-size:10.5px; font-weight:600;
          padding:2px 7px 2px 6px; border-radius:20px; flex-shrink:0; letter-spacing:.01em;
          font-family:"SF Mono","Fira Code",Consolas,monospace; cursor:help; border:1px solid transparent; }
        .gate-dot { width:5px; height:5px; border-radius:50%; flex-shrink:0; }
        .gate-auto { background:var(--green-bg); color:var(--green); border-color:color-mix(in srgb, var(--green) 22%, transparent); }
        .gate-auto .gate-dot { background:var(--green); }
        .gate-ask { background:var(--yellow-bg); color:var(--yellow); border-color:color-mix(in srgb, var(--yellow) 26%, transparent); }
        .gate-ask .gate-dot { background:var(--yellow); }
        .gate-user { background:var(--accent-soft); color:var(--accent); border-color:color-mix(in srgb, var(--accent) 24%, transparent); }
        .gate-user .gate-dot { background:var(--accent); }
        .gate-deny { background:var(--red-bg); color:var(--red); border-color:color-mix(in srgb, var(--red) 26%, transparent); }
        .gate-deny .gate-dot { background:var(--red); }
      `}</style>
    </span>
  );
}
