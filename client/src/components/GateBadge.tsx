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
      <span className="gate-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
