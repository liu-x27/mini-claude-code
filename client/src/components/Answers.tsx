import type { CSSProperties } from "react";
import type { GateVerdict } from "../hooks/useChat";

/*
 * The pieces every theme uses to draw what the risk gate decided: a 0–1
 * scale with the threshold marked, a ring gauge, and one row per question.
 * Each theme's stylesheet shows the ones it wants.
 */

export const DEFAULT_THRESHOLD = 0.2;

const SHORT: Record<string, string> = {
  "destroys-data": "destroys",
  "outside-cwd": "outside cwd",
  exfiltrates: "exfil",
  "reveals-secret": "secret",
};

/** What a question being above threshold means, as a clause. */
const MEANS: Record<string, string> = {
  "destroys-data": "destroys data it cannot restore",
  "outside-cwd": "reaches outside the working directory",
  exfiltrates: "sends data off this machine",
  "reveals-secret": "exposes a secret",
};

export const shortName = (id: string) => SHORT[id] ?? id;

/** ".074" — three decimals without the leading zero, the way the gate is read. */
export const fmtP = (p: number | undefined) => (p === undefined ? "—" : p.toFixed(3).replace(/^0/, ""));

export function worst(gate: GateVerdict | undefined) {
  if (!gate?.answers?.length) return undefined;
  return gate.answers.reduce((a, b) => (b.probability > a.probability ? b : a));
}

/** One sentence on why a call was held, from the questions that crossed the threshold. */
export function whyHeld(gate: GateVerdict | undefined): string {
  if (!gate) return "No judge was consulted, so this came to you.";
  if (gate.probability === undefined) return "The judge could not produce a probability, so this came to you.";
  const threshold = gate.threshold ?? DEFAULT_THRESHOLD;
  const over = (gate.answers ?? []).filter((a) => a.probability >= threshold).map((a) => MEANS[a.id] ?? a.id);
  if (over.length === 0) return `The judge scored it ${fmtP(gate.probability)}, not below ${threshold}.`;
  if (over.length === 1) return `The judge thinks this ${over[0]}.`;
  return `The judge thinks this ${over.slice(0, -1).join(", ")}, and that it ${over.at(-1)}. Either is enough to stop it.`;
}

type Tone = "ok" | "hot" | "mid";
const toneOf = (p: number, threshold: number): Tone => (p < threshold ? "ok" : p >= 0.5 ? "hot" : "mid");

/** 0 → 1 with the threshold marked and a pin at the worst answer. */
export function Scale({ gate }: { gate: GateVerdict }) {
  const threshold = gate.threshold ?? DEFAULT_THRESHOLD;
  const p = gate.probability;
  return (
    <div className="scale" style={{ "--t": threshold } as CSSProperties} aria-hidden="true">
      <span className="scale-track" />
      <span className="scale-safe" />
      <span className="scale-threshold">
        <span>{threshold.toFixed(2)}</span>
      </span>
      {p !== undefined && (
        <span className="scale-pin" data-tone={toneOf(p, threshold)} style={{ "--p": p } as CSSProperties}>
          <span>{fmtP(p)}</span>
        </span>
      )}
    </div>
  );
}

/** A conic ring filled to p. */
export function Ring({ p, threshold, size }: { p: number | undefined; threshold: number; size?: "sm" | "lg" }) {
  return (
    <span
      className={size ? `ring ring-${size}` : "ring"}
      data-tone={p === undefined ? "mid" : toneOf(p, threshold)}
      style={{ "--p": p ?? 0 } as CSSProperties}
    >
      <b>{fmtP(p)}</b>
    </span>
  );
}

/** One row per question: name, bar, ring, number. */
export function AnswerRows({ gate }: { gate: GateVerdict }) {
  const threshold = gate.threshold ?? DEFAULT_THRESHOLD;
  const rows = [...(gate.answers ?? [])].sort((a, b) => b.probability - a.probability);
  if (rows.length === 0) return null;
  return (
    <div className="answers" style={{ "--t": threshold } as CSSProperties}>
      {rows.map((a) => (
        <div key={a.id} className="answer" data-tone={toneOf(a.probability, threshold)}>
          <Ring p={a.probability} threshold={threshold} size="sm" />
          <span className="answer-id">{a.id}</span>
          <span className="answer-short">{shortName(a.id)}</span>
          <span className="answer-bar" style={{ "--p": a.probability } as CSSProperties} />
          <span className="answer-p">{a.probability.toFixed(3)}</span>
        </div>
      ))}
    </div>
  );
}
