import { useCallback, useEffect, useState } from "react";

/**
 * Two themes over one component tree. They differ in tokens and in a few
 * structural rules (see styles/app.css), never in markup, so a feature added
 * once shows up in both.
 */
export type Theme = "product" | "terminal";

export const THEMES: Array<{ value: Theme; label: string; hint: string }> = [
  { value: "product", label: "Product", hint: "Light, quiet, card-based" },
  { value: "terminal", label: "Terminal", hint: "Dark, monospace, log-style" },
];

/** Same rule as the inline script in index.html, which applies it before first paint. */
export function initialTheme(): Theme {
  const saved = localStorage.getItem("theme");
  if (saved === "product" || saved === "terminal") return saved;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "terminal" : "product";
}

export function useTheme(): [Theme, (t: Theme) => void, () => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === "product" ? "terminal" : "product")), []);
  return [theme, setTheme, toggle];
}
