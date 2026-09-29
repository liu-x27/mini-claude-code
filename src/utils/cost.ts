import type { ModelId } from "../types.js";

/**
 * Pricing per 1M tokens in USD, Anthropic first-party rates as of 2026-09.
 * cacheWrite is the 5-minute TTL (1.25× input).
 */
const PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-fable-5-1": { input: 10.0, output: 50.0, cacheWrite: 12.5, cacheRead: 0.25 },
  "claude-fable-5": { input: 10.0, output: 50.0, cacheWrite: 12.5, cacheRead: 1.0 },
  "claude-opus-5-5": { input: 4.0, output: 20.0, cacheWrite: 5.0, cacheRead: 0.2 },
  "claude-opus-5": { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2.0, output: 10.0, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2.0, output: 10.0, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
  // Previous generation, still served.
  "claude-opus-4-8": { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
};

/**
 * Estimated cost of one call, or null for a model this table does not price.
 *
 * It used to price every unknown model as Claude Opus 5: 25% too high for
 * Opus 5.5, 150% for Sonnet 5.5, and a made-up number for MiniMax or a local
 * Ollama. A fallback that looks like an answer is the failure this project
 * keeps refusing elsewhere, so unknown stays unknown.
 */
export function estimateCost(
  model: ModelId,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens = 0,
  cacheReadTokens = 0,
): number | null {
  const p = PRICING[model];
  if (!p) return null;
  const M = 1_000_000;

  return (
    (inputTokens / M) * p.input +
    (outputTokens / M) * p.output +
    (cacheCreationTokens / M) * p.cacheWrite +
    (cacheReadTokens / M) * p.cacheRead
  );
}

/** Add two costs; unknown stays unknown. */
export function addCost(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

export function formatCost(usd: number | null): string {
  if (usd === null) return "cost unknown";
  if (usd < 0.001) return `$${(usd * 1000).toFixed(3)}m`;
  return `$${usd.toFixed(4)}`;
}
