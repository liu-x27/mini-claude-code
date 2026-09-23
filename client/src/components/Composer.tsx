import { forwardRef, useCallback, useLayoutEffect, useRef, useImperativeHandle } from "react";
import { Icon } from "./Icon";

export interface ComposerHandle {
  focus: () => void;
}

/**
 * The message box. A real <form>, so Enter, the send button and anything
 * scripting the page (docs/capture-screenshots.mjs) all submit the same way.
 */
export const Composer = forwardRef<
  ComposerHandle,
  {
    value: string;
    onChange: (v: string) => void;
    onSend: () => void;
    onStop: () => void;
    busy: boolean;
    disabled: boolean;
    sessionId: string | null;
  }
>(function Composer({ value, onChange, onSend, onStop, busy, disabled, sessionId }, ref) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => areaRef.current?.focus() }), []);

  // Grow with the text up to a cap, and shrink back when it is sent.
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      formRef.current?.requestSubmit();
    }
  }, []);

  const canSend = !!value.trim() && !disabled;
  return (
    <div className="composer-wrap">
      <form
        ref={formRef}
        className="composer"
        data-busy={busy || undefined}
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend && !busy) onSend();
        }}
      >
        <span className="composer-prompt" aria-hidden="true">
          ›
        </span>
        <textarea
          ref={areaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message Agent…"
          rows={1}
          disabled={busy}
          aria-label="Message"
        />
        {busy ? (
          <button type="button" className="send is-stop" onClick={onStop} title="Stop" aria-label="Stop">
            <Icon name="stop" size={14} />
          </button>
        ) : (
          <button type="submit" className="send" disabled={!canSend} title="Send" aria-label="Send">
            <Icon name="arrowUp" size={15} />
          </button>
        )}
      </form>
      <div className="composer-hint">
        <span>
          <kbd>Enter</kbd> to send · <kbd>Shift</kbd> <kbd>Enter</kbd> for a new line
        </span>
        {sessionId && <span className="composer-session">session {sessionId.slice(0, 8)}</span>}
      </div>
    </div>
  );
});
