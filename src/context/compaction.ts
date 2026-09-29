import type { ConversationMessage, ModelId } from "../types.js";

/**
 * Context windows of the models this harness knows. Anything else is
 * assumed to have 128K, which `AGENT_CONTEXT_WINDOW` overrides — a local
 * model's real window is a server setting no API reports.
 */
const WINDOWS: Record<string, number> = {
  "claude-fable-5-1": 1_000_000,
  "claude-fable-5": 1_000_000,
  "claude-opus-5-5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-5-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
};

export function contextWindow(model: ModelId): number {
  const override = Number(process.env.AGENT_CONTEXT_WINDOW);
  if (Number.isFinite(override) && override > 0) return override;
  return WINDOWS[model] ?? 128_000;
}

/**
 * Prompt size at which the conversation is compacted before the next call:
 * 80% of the window, and never more than 150K, the point at which the
 * Messages API's own compaction triggers by default. A 1M window is not a
 * reason to pay for a million tokens of history on every turn.
 */
export function defaultCompactAt(model: ModelId): number {
  return Math.min(Math.floor(contextWindow(model) * 0.8), 150_000);
}

export const COMPACTION_PROMPT = `Write a summary of this conversation so far that another instance of you could continue from with no other context. Do not call any tools. Use these sections:

1. Task — what the user asked for, in their words where the wording matters, including requests still open.
2. Constraints and preferences — rules the user or the project set.
3. Done so far — actions taken and what they showed: files read or changed (with paths), commands run and their results.
4. Findings — facts the next steps depend on: names, values, errors, decisions and the reasons for them.
5. Current state — what is in progress, what failed, what is still uncertain.
6. Next steps — what to do next, in order.

Keep file paths, identifiers, commands and error messages exact. Leave out anything the next steps do not need.`;

/**
 * The conversation as plain text, for a second attempt at the summary with no
 * tools declared. Some compatible endpoints ignore tool_choice "none" — a
 * local Ollama answered the first attempt with another tool call — and a
 * request holding tool_use blocks cannot simply drop its tools. Long tool
 * results are cut: this is for the summary, and the transcript is archived.
 */
export function renderTranscript(messages: ConversationMessage[], perBlock = 4000): string {
  const clip = (s: string) => (s.length > perBlock ? `${s.slice(0, perBlock)} […]` : s);
  const lines: string[] = [];
  for (const m of messages) {
    const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    for (const b of blocks) {
      if (b.type === "text") lines.push(`${m.role}: ${clip(b.text)}`);
      else if (b.type === "tool_use") lines.push(`${m.role} called ${b.name}: ${clip(JSON.stringify(b.input))}`);
      else if (b.type === "tool_result") {
        const content = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        lines.push(`tool result${b.is_error ? " (error)" : ""}: ${clip(content)}`);
      }
    }
  }
  return lines.join("\n\n");
}

/**
 * The history after compaction: one user message holding the summary, and
 * nothing else from before. Replaying none of the earlier turns — no
 * messages, no thinking blocks — is the shape Anthropic recommends for a
 * client-side compaction; a summary with the last turns kept verbatim
 * breaks on models that bind thinking blocks to the prompt that produced
 * them. `continuing` is the request being worked on, when compacting mid-run
 * where no new prompt follows: quoted as the user wrote it, since a summary
 * alone left a small model answering questions nobody had asked.
 */
export function compactedHistory(
  summary: string,
  transcript: string | undefined,
  continuing: string | undefined,
): ConversationMessage[] {
  const where = transcript
    ? `The full transcript up to this point is in ${transcript}; read it only if something below is missing.`
    : "The full transcript could not be saved.";
  const blocks = [
    {
      type: "text" as const,
      text: `[Earlier turns of this session were compacted to fit the context budget. ${where}]\n\n<summary>\n${summary.trim()}\n</summary>`,
    },
    ...(continuing !== undefined
      ? [
          {
            type: "text" as const,
            text: `Continue from where the summary leaves off; what it lists under Done so far is already done. The request you are working on, as the user wrote it:\n\n${continuing}`,
          },
        ]
      : []),
  ];
  return [{ role: "user", content: blocks }];
}
