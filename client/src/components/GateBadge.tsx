import type { GateVerdict } from "../hooks/useChat";

/**
 * What the risk gate did to one tool call, as a word.
 *
 * Worth its own chip because the gate's entire effect is a prompt that does
 * not appear, and an absence is not something a user can notice. The number
 * it decided on sits beside it — on a scale, in a ring, or in a margin
 * note, depending on the theme — and in the tooltip.
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
  // 0.995 to "1.00", which claims a certainty nothing measured.
  const shown = p === undefined ? "no probability" : p.toFixed(3);

  // A deferral the user then approved is a different outcome from one still
  // waiting, so there are four states, not the gate's three actions.
  const [label, tone] = approvedByUser
    ? ["you approved", "user" as const]
    : gate.action === "allow"
      ? ["cleared", "auto" as const]
      : gate.action === "deny"
        ? ["blocked", "deny" as const]
        : ["held", "ask" as const];

  return (
    <span className={`gate-badge gate-${tone}`} title={`${gate.judge} · ${shown} · ${gate.reason}`}>
      <span className="gate-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
