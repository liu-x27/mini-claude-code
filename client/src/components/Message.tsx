import { useState } from "react";
import type { Message as MessageData } from "../hooks/useChat";
import { renderMarkdown, withCaret } from "../lib/markdown";
import { Icon } from "./Icon";
import { ToolCall } from "./ToolCall";

export function Message({
  msg,
  modelLabel,
  waitingToolId,
}: {
  msg: MessageData;
  modelLabel: string;
  /** The tool call an approval card is currently asking about, if it is in this message. */
  waitingToolId?: string | undefined;
}) {
  if (msg.role === "user") {
    return (
      <article className="msg msg-user">
        <div className="msg-user-body">{msg.content}</div>
      </article>
    );
  }

  const tools = msg.toolCalls ?? [];
  return (
    <article className="msg msg-assistant" data-streaming={msg.isStreaming || undefined}>
      <header className="msg-head">
        <span className="msg-avatar" aria-hidden="true" />
        {/* The label follows the configured model: the server talks to any
            Anthropic- or OpenAI-compatible endpoint, so a hardcoded "Claude"
            is wrong as often as it is right. */}
        <span className="msg-who">{modelLabel}</span>
        {msg.isStreaming && !msg.error && <span className="msg-live">working</span>}
      </header>

      {msg.thinking && <Thinking text={msg.thinking} />}

      {tools.length > 0 && (
        <div className="steps">
          {tools.map((tc) => (
            <ToolCall key={tc.id} tc={tc} waiting={tc.id === waitingToolId} />
          ))}
        </div>
      )}

      {msg.error ? (
        <div className="msg-error" role="alert">
          <Icon name="alert" size={15} />
          <span>{msg.error}</span>
        </div>
      ) : (
        // A caret on its own only before anything has happened; once tool
        // calls are showing, the running call or the approval card says it.
        (msg.content || (msg.isStreaming && tools.length === 0)) && (
          <div
            className="prose"
            dangerouslySetInnerHTML={{
              __html: msg.isStreaming ? withCaret(renderMarkdown(msg.content)) : renderMarkdown(msg.content),
            }}
          />
        )
      )}

      {msg.usage && (
        <footer className="msg-meta">
          <span>{msg.usage.inputTokens.toLocaleString()} in</span>
          <span>{msg.usage.outputTokens.toLocaleString()} out</span>
          <span>${msg.usage.cost.toFixed(5)}</span>
        </footer>
      )}
    </article>
  );
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
