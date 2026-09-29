/**
 * The most characters of one tool result the model is shown.
 *
 * 40,000 characters is about 10,000 tokens, the per-call budget Codex gives
 * its tools. Without a limit a single `cat` of a log or a minified bundle
 * goes back whole: one Bash call here once handed the model three million
 * characters, enough to push the next request past the context window.
 */
export const MAX_TOOL_OUTPUT_CHARS = readLimit(process.env.AGENT_MAX_TOOL_OUTPUT, 40_000);

function readLimit(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : fallback;
}

/**
 * Keep the start and the end of `text`, and say how much was cut between them.
 *
 * `headShare` is the fraction of the budget spent on the start. Command output
 * usually carries its verdict at the end, so the shell keeps more of the tail;
 * a file or a search result is read from the top, so the default is even.
 * `note`, when given, goes in the marker: where the rest can be found.
 */
export function truncateMiddle(
  text: string,
  max: number = MAX_TOOL_OUTPUT_CHARS,
  headShare = 0.5,
  note?: string,
): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * headShare);
  const tail = max - head;
  const omitted = text.length - head - tail;
  const marker = `[… ${omitted.toLocaleString("en-US")} characters omitted${note ? `; ${note}` : ""} …]`;
  return `${text.slice(0, head)}\n\n${marker}\n\n${text.slice(text.length - tail)}`;
}
