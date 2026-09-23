import { useState } from "react";
import type { Message, PendingApproval, ToolCall as ToolCallData } from "../hooks/useChat";
import { renderMarkdown, withCaret } from "../lib/markdown";
import { ApprovalCard } from "./ApprovalCard";
import { Icon, TOOL_ICONS } from "./Icon";
import { ToolCall, ToolNote } from "./ToolCall";

/** A question and the reply to it — the unit every theme lays out. */
interface Turn {
  n: number;
  user: Message | undefined;
  reply: Message | undefined;
}

function toTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role === "user" || turns.length === 0) turns.push({ n: turns.length + 1, user: undefined, reply: undefined });
    const t = turns[turns.length - 1]!;
    if (m.role === "user") t.user = m;
    else t.reply = m;
  }
  return turns;
}

/**
 * The transcript, as turns. Each turn has three slots — its number, the
 * conversation, and margin notes for its tool calls — and each theme shows
 * the slots it wants: Editorial all three, the others only the middle.
 * Tool calls are numbered across the whole transcript, like footnotes.
 */
export function Thread({
  messages,
  modelLabel,
  pending,
  onRespond,
}: {
  messages: Message[];
  modelLabel: string;
  pending: PendingApproval | null;
  onRespond: (id: string, decision: "allow" | "deny" | "always-allow") => void;
}) {
  const turns = toTurns(messages);
  let ref = 0;
  const refs = new Map<string, number>();
  for (const t of turns) for (const tc of t.reply?.toolCalls ?? []) refs.set(tc.id, ++ref);

  return (
    <>
      {turns.map((t, i) => {
        const tools = t.reply?.toolCalls ?? [];
        const last = i === turns.length - 1;
        return (
          <section key={t.user?.id ?? t.reply?.id ?? i} className="turn">
            <span className="turn-num">{String(t.n).padStart(2, "0")}</span>
            <div className="turn-main">
              {t.user && (
                <div className="msg-user">
                  {/* Editorial sets the question as a pull quote, which a
                      paragraph of it would not survive. */}
                  <p className="msg-user-body" data-long={t.user.content.length > 160 || undefined}>
                    {t.user.content}
                  </p>
                </div>
              )}
              {t.reply && (
                <Reply
                  msg={t.reply}
                  modelLabel={modelLabel}
                  refs={refs}
                  waitingId={pending?.toolUseId}
                />
              )}
              {last && pending && (
                <ApprovalCard
                  approval={pending}
                  onRespond={onRespond}
                  refNo={pending.toolUseId ? refs.get(pending.toolUseId) : undefined}
                />
              )}
            </div>
            <aside className="turn-notes">
              {tools.map((tc) => (
                <ToolNote key={tc.id} tc={tc} refNo={refs.get(tc.id)!} waiting={tc.id === pending?.toolUseId} />
              ))}
              {last && (
                <p className="colophon">
                  A model may clear what your rules would ask about. It may never reopen what they deny.
                </p>
              )}
            </aside>
          </section>
        );
      })}
    </>
  );
}

function Reply({
  msg,
  modelLabel,
  refs,
  waitingId,
}: {
  msg: Message;
  modelLabel: string;
  refs: Map<string, number>;
  waitingId: string | undefined;
}) {
  const tools = msg.toolCalls ?? [];
  const showProse = !!msg.content || (msg.isStreaming && tools.length === 0);
  const html = showProse
    ? msg.isStreaming
      ? withCaret(renderMarkdown(msg.content))
      : withRefs(renderMarkdown(msg.content), tools, refs)
    : "";
  return (
    <div className="msg-reply" data-streaming={msg.isStreaming || undefined}>
      <header className="msg-head">
        <span className="msg-avatar" aria-hidden="true" />
        {/* The model's own name: the server talks to any Anthropic- or
            OpenAI-compatible endpoint, so a fixed "Claude" would be wrong
            as often as right. */}
        <span className="msg-who">{modelLabel}</span>
        {msg.isStreaming && !msg.error && <span className="msg-live">working</span>}
        <span className="msg-rule" aria-hidden="true" />
      </header>

      {msg.thinking && <Thinking text={msg.thinking} />}

      {tools.length > 0 && (
        <div className="steps">
          {tools.map((tc) => (
            <ToolCall key={tc.id} tc={tc} waiting={tc.id === waitingId} refNo={refs.get(tc.id)} />
          ))}
        </div>
      )}

      {msg.error ? (
        <div className="msg-error" role="alert">
          <Icon name="alert" size={15} />
          <span>{msg.error}</span>
        </div>
      ) : (
        showProse && (
          <div className="prose-line">
            <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        )
      )}

      {msg.usage && (
        <footer className="msg-meta">
          <span>{modelLabel}</span>
          <span>
            {msg.usage.inputTokens.toLocaleString()} in · {msg.usage.outputTokens.toLocaleString()} out
          </span>
          <span>${msg.usage.cost.toFixed(5)}</span>
        </footer>
      )}
    </div>
  );
}

/**
 * Footnote markers pointing at this reply's margin notes (only Editorial
 * shows them), set inside the last paragraph so they sit on its last line.
 * The markup is ours and holds only numbers; the text around it was escaped
 * by renderMarkdown.
 */
function withRefs(html: string, tools: ToolCallData[], refs: Map<string, number>): string {
  if (tools.length === 0) return html;
  const sup = `<sup class="refs">${tools.map((tc) => refs.get(tc.id)).join(",")}</sup>`;
  return /<\/p>\s*$/.test(html) ? html.replace(/<\/p>\s*$/, `${sup}</p>`) : html + sup;
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking" data-open={open || undefined}>
      <button type="button" className="thinking-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="brain" size={14} />
        <span>{open ? "Hide" : "Show"} reasoning</span>
        <span className="thinking-size">~{Math.ceil(text.length / 4)} tokens</span>
        <Icon name="chevron" size={13} className="thinking-chevron" />
      </button>
      {open && <pre className="thinking-body">{text}</pre>}
    </div>
  );
}

const SUGGESTIONS = [
  { title: "Map the repo", prompt: "List the files in this directory and say what each top-level folder is for." },
  { title: "Explain the architecture", prompt: "Read src/ and explain how the agent loop, tools and permissions fit together." },
  { title: "Find loose ends", prompt: "Search the code for TODO and FIXME comments and summarise them." },
  { title: "Measure something", prompt: "Count the lines in src/agent.ts with wc -l and report the number." },
];

export function EmptyState({ tools, onPick }: { tools: string[]; onPick: (prompt: string) => void }) {
  return (
    <section className="empty">
      <span className="empty-mark" aria-hidden="true" />
      <p className="empty-kicker">A new session</p>
      <h1 className="empty-title">What should we work on?</h1>
      <p className="empty-sub">
        Tools run on this machine. Anything that writes or runs a command is scored by the risk gate first, and
        what it cannot clear comes to you.
      </p>
      <div className="empty-tools" aria-label="Tools available">
        {tools.map((t) => (
          <span key={t} className="tool-chip">
            <Icon name={TOOL_ICONS[t] ?? "tool"} size={13} />
            {t}
          </span>
        ))}
      </div>
      <ol className="suggestions">
        {SUGGESTIONS.map((s, i) => (
          <li key={s.title}>
            <button type="button" className="suggestion" onClick={() => onPick(s.prompt)}>
              <span className="suggestion-index">{String(i + 1).padStart(2, "0")}</span>
              <span className="suggestion-title">{s.title}</span>
              <span className="suggestion-prompt">{s.prompt}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
