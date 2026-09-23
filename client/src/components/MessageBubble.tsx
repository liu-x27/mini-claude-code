import { useState } from "react";
import { ToolCallCard } from "./ToolCallCard";
import type { Message } from "../hooks/useChat";
import { renderMarkdown } from "../lib/markdown";

export function MessageBubble({ msg, modelLabel }: { msg: Message; modelLabel?: string }) {
  const [showThinking, setShowThinking] = useState(false);
  const isUser = msg.role === "user";

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: isUser ? "flex-end" : "flex-start",
      marginBottom: 24,
      maxWidth: "100%",
    }}>
      {/* Role label */}
      <div style={{
        fontSize: 11.5,
        fontWeight: 600,
        color: "var(--text-3)",
        marginBottom: 5,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        paddingLeft: isUser ? 0 : 2,
        paddingRight: isUser ? 2 : 0,
      }}>
        {/* The label follows the configured model: the server talks to any
            Anthropic- or OpenAI-compatible endpoint, so a hardcoded "Claude"
            is wrong as often as it is right. */}
        {isUser ? "You" : (modelLabel ?? "Assistant")}
      </div>

      {/* Bubble */}
      <div style={{
        maxWidth: isUser ? "75%" : "100%",
        background: isUser ? "var(--bg-user)" : "transparent",
        border: isUser ? "1px solid var(--border-md)" : "none",
        borderRadius: isUser ? 16 : 0,
        padding: isUser ? "10px 16px" : "0",
        lineHeight: 1.7,
        fontSize: 14.5,
        color: "var(--text)",
      }}>
        {/* Thinking block */}
        {msg.thinking && (
          <div style={{ marginBottom: 12 }}>
            <button
              onClick={() => setShowThinking(v => !v)}
              style={{
                background: "var(--accent-soft)",
                border: "1px solid rgba(218,119,86,0.25)",
                borderRadius: 6,
                color: "var(--accent)",
                cursor: "pointer",
                fontSize: 12,
                padding: "4px 10px",
                fontWeight: 500,
              }}
            >
              💭 {showThinking ? "Hide" : "Show"} thinking ({Math.ceil(msg.thinking.length / 4)} tok)
            </button>
            {showThinking && (
              <pre style={{
                marginTop: 8,
                padding: "10px 14px",
                background: "var(--accent-soft)",
                border: "1px solid rgba(218,119,86,0.2)",
                borderRadius: 8,
                color: "var(--accent-h)",
                fontSize: 12,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 300,
                overflow: "auto",
                lineHeight: 1.6,
              }}>{msg.thinking}</pre>
            )}
          </div>
        )}

        {/* Tool calls */}
        {msg.toolCalls && msg.toolCalls.length > 0 && (
          <div style={{ marginBottom: msg.content ? 14 : 0 }}>
            {msg.toolCalls.map(tc => (
              <ToolCallCard key={tc.id} tc={tc} />
            ))}
          </div>
        )}

        {/* Main content */}
        {msg.error ? (
          <div style={{
            padding: "10px 14px",
            background: "var(--red-bg)",
            border: "1px solid rgba(192,57,43,0.2)",
            borderRadius: 8,
            color: "var(--red)",
            fontSize: 14,
          }}>⚠ {msg.error}</div>
        ) : isUser ? (
          <span style={{ whiteSpace: "pre-wrap" }}>{msg.content}</span>
        ) : (
          <div
            className="md"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
          />
        )}

        {/* Streaming cursor */}
        {msg.isStreaming && !msg.error && (
          <span style={{
            display: "inline-block",
            width: 2,
            height: 16,
            background: "var(--accent)",
            marginLeft: 2,
            verticalAlign: "middle",
            animation: "blink 1s step-end infinite",
            borderRadius: 1,
          }} />
        )}
      </div>

      {/* Usage stats */}
      {msg.usage && (
        <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 5, paddingLeft: 2 }}>
          {msg.usage.inputTokens}↑ {msg.usage.outputTokens}↓ · ${msg.usage.cost.toFixed(5)}
        </div>
      )}
    </div>
  );
}
