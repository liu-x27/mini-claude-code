import { useCallback, useEffect, useState } from "react";

/**
 * Three themes over one set of data components. They differ in layout as
 * well as in paint — Instrument has a decision rail, Editorial puts tool
 * calls in the margin — so each has its own layout component and stylesheet,
 * while the transcript, tool calls, approvals and composer are shared.
 */
export type Theme = "instrument" | "editorial" | "aurora";

export const THEMES: Array<{ value: Theme; label: string; hint: string }> = [
  { value: "instrument", label: "Instrument", hint: "Dark, with the risk gate on a rail" },
  { value: "editorial", label: "Editorial", hint: "Paper, serif, tool calls in the margin" },
  { value: "aurora", label: "Aurora", hint: "Glass over a slow gradient" },
];

const NEXT: Record<Theme, Theme> = { instrument: "editorial", editorial: "aurora", aurora: "instrument" };

/** Same rule as the inline script in index.html, which applies it before first paint. */
export function initialTheme(): Theme {
  const saved = localStorage.getItem("theme");
  if (saved === "instrument" || saved === "editorial" || saved === "aurora") return saved;
  // The two themes these replaced map onto the nearest of the three.
  if (saved === "terminal") return "instrument";
  if (saved === "product") return "editorial";
  return matchMedia("(prefers-color-scheme: dark)").matches ? "instrument" : "editorial";
}

export function useTheme(): [Theme, (t: Theme) => void, () => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  const cycle = useCallback(() => setTheme((t) => NEXT[t]), []);
  return [theme, setTheme, cycle];
}

export const nextTheme = (t: Theme) => NEXT[t];
