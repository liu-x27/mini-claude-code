import { useEffect, useRef } from "react";
import { Icon } from "./Icon";

/**
 * The sessions list, as a slide-over from the left in every theme. Only the
 * current session so far: the server saves every session, but resuming one
 * from the browser is not built yet, and a list that cannot be opened would
 * be a promise the UI does not keep.
 */
export function Sessions({
  open,
  onClose,
  sessionId,
  onNewChat,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string | null;
  onNewChat: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  return (
    <>
      <div className="scrim" data-open={open || undefined} onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer drawer-left"
        data-open={open || undefined}
        inert={!open}
        role="dialog"
        aria-label="Sessions"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="drawer-head">
          <h2>Sessions</h2>
          <button ref={closeRef} type="button" className="icon-btn" onClick={onClose} aria-label="Close sessions">
            <Icon name="close" />
          </button>
        </header>
        <div className="drawer-body">
          <button
            type="button"
            className="new-session"
            onClick={() => {
              onNewChat();
              onClose();
            }}
          >
            <Icon name="plus" size={15} />
            New session
          </button>
          {sessionId ? (
            <div className="session is-active">
              <span className="session-label">Current</span>
              <code className="session-id">{sessionId.slice(0, 8)}</code>
            </div>
          ) : (
            <p className="field-hint">Your first message starts a session.</p>
          )}
          <p className="field-hint">
            Saved to <code>~/.agent-app/sessions</code>
          </p>
        </div>
      </aside>
    </>
  );
}
