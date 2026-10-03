import type { BrowserPageWindow } from "@winston/domain/browser";
import {
  Button,
  EmptyState,
  IconButton,
  Select,
  StatusPill,
  type StatusTone,
} from "@winston/ui";
import { AppWindow, Globe, Monitor } from "lucide-react";
import type { ReactNode } from "react";
import type { ConnectionState } from "../browser/connection";

/**
 * Winston's browser, live (docs/design.md §5, §20): his open windows, the
 * chosen one playing as he works in it. While he drives, it's watch-only;
 * when he hands over (or the person takes over), the controls turn on, and
 * Done gives it back. On a phone almost always, from a link in Telegram.
 */
export function BrowserPage({
  state,
  windows,
  selected,
  control,
  onSelect,
  onTakeOver,
  onDone,
  onKeyboard,
  desktop,
  screen,
  keyboard,
}: {
  state: ConnectionState;
  /** Undefined until the first list arrives. */
  windows: BrowserPageWindow[] | undefined;
  selected: BrowserPageWindow | undefined;
  /** Whether this page has control of the selected window. */
  control: boolean;
  onSelect: (windowId: string) => void;
  onTakeOver: () => void;
  onDone: () => void;
  onKeyboard: () => void;
  /** The full-desktop fallback, while the page has control. */
  desktop?: { open: boolean; onToggle: () => void } | undefined;
  /** The window, drawn as frames arrive (a canvas). */
  screen: ReactNode;
  /** The hidden field that brings up the phone's keyboard. */
  keyboard?: ReactNode;
}) {
  const status = statuses[state];
  const empty = windows?.length === 0;
  return (
    <main className="flex h-dvh flex-col bg-surface-sunken">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle bg-surface px-4">
        <div className="flex min-w-0 flex-1">
          {windows && windows.length > 1 && selected ? (
            <Select
              size="sm"
              aria-label="Window"
              className="max-w-full min-w-0 [&>span:first-child]:truncate"
              value={selected.id}
              options={windows.map((w) => ({
                value: w.id,
                label: windowLabel(w),
              }))}
              onValueChange={onSelect}
            />
          ) : (
            <span className="truncate text-sm font-semibold text-fg">
              {selected ? windowLabel(selected) : "Winston's browser"}
            </span>
          )}
        </div>
        <StatusPill tone={status.tone}>
          {desktop?.open ? "Full desktop" : status.label}
        </StatusPill>
        {desktop && (
          <IconButton
            size="sm"
            label={
              desktop.open ? "Back to the window" : "Show the full desktop"
            }
            onClick={desktop.onToggle}
          >
            {desktop.open ? <AppWindow /> : <Monitor />}
          </IconButton>
        )}
      </header>
      {selected && (
        <WindowBar
          window={selected}
          control={control}
          onTakeOver={onTakeOver}
        />
      )}
      <div className="relative flex min-h-0 flex-1 items-start justify-center overflow-hidden">
        {empty ? (
          <div className="flex size-full items-center justify-center px-4">
            <EmptyState
              icon={<Globe />}
              title="No windows open"
              description="When Winston opens a page, it shows up here, live."
            />
          </div>
        ) : (
          screen
        )}
      </div>
      {control && selected && (
        <footer className="flex shrink-0 items-center gap-3 border-t border-border-subtle bg-surface px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <Button className="flex-1" onClick={onKeyboard}>
            Keyboard
          </Button>
          <Button className="flex-1" variant="primary" onClick={onDone}>
            {selected.held === "takeover" ? "Give back" : "Done"}
          </Button>
          {keyboard}
        </footer>
      )}
    </main>
  );
}

/** Who has the window, and what to do about it. */
function WindowBar({
  window,
  control,
  onTakeOver,
}: {
  window: BrowserPageWindow;
  control: boolean;
  onTakeOver: () => void;
}) {
  const [text, action] =
    window.held === "handoff" && control
      ? [`Your turn: ${window.reason ?? "Winston needs you here."}`, null]
      : window.held === "takeover" && control
        ? ["You have this window. Winston waits until you give it back.", null]
        : window.held && window.control === "elsewhere"
          ? ["It's open for you on another screen.", "Use here"]
          : window.held
            ? [
                `Your turn: ${window.reason ?? "Winston needs you here."}`,
                "Take it",
              ]
            : ["Winston is browsing. You're watching.", "Take over"];
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border-subtle bg-surface px-4 py-2">
      <p className="min-w-0 flex-1 text-sm text-fg-muted">{text}</p>
      {action && (
        <Button size="sm" onClick={onTakeOver}>
          {action}
        </Button>
      )}
    </div>
  );
}

/** A window's name in the switcher: what it's for, and its site. */
export function windowLabel(window: BrowserPageWindow) {
  const site = hostOf(window.url);
  const purpose =
    window.task === null
      ? "Conversation"
      : window.task
        ? `Task: ${window.task.length > 40 ? `${window.task.slice(0, 39)}…` : window.task}`
        : "Task";
  return site ? `${purpose} · ${site}` : purpose;
}

const hostOf = (url: string) => {
  try {
    const { protocol, host } = new URL(url);
    return protocol === "http:" || protocol === "https:"
      ? host.replace(/^www\./, "")
      : "";
  } catch {
    return "";
  }
};

const statuses: Record<ConnectionState, { tone: StatusTone; label: string }> = {
  connecting: { tone: "pending", label: "Connecting" },
  live: { tone: "ok", label: "Live" },
  reconnecting: { tone: "attention", label: "Reconnecting" },
};
