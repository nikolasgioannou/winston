import {
  Button,
  EmptyState,
  IconButton,
  StatusPill,
  type StatusTone,
} from "@winston/ui";
import {
  AppWindow,
  CircleCheck,
  Clock,
  Link2Off,
  Monitor,
  MonitorSmartphone,
} from "lucide-react";
import type { ReactNode } from "react";
import type { LiveState } from "../handoff/input";

/**
 * The live view a handoff link opens (docs/design.md §5, §20), on a phone
 * almost always: one tab of Winston's browser, live, to sign in, enter a
 * code or tap through what he can't. No sidebar and no sign-in: the link is
 * the credential. Done hands the browser back (saying "done" in Telegram
 * does too, the founder's call: tapping it here saves switching apps).
 * A quiet header button switches to the full desktop, for native dialogs
 * the tab's view can't show.
 */
export function HandoffPage({
  state,
  screen,
  keyboard,
  onKeyboard,
  onDone,
  desktop,
}: {
  state: LiveState;
  /** The tab, drawn as frames arrive (a canvas). */
  screen: ReactNode;
  /** The hidden field that brings up the phone's keyboard. */
  keyboard?: ReactNode;
  onKeyboard?: () => void;
  /** Hands the browser back to Winston. */
  onDone?: () => void;
  /** The full-desktop fallback: whether it's showing, and the switch. */
  desktop?: { open: boolean; onToggle: () => void };
}) {
  const ended =
    state in endings ? endings[state as keyof typeof endings] : undefined;
  if (ended)
    return (
      <main className="flex min-h-dvh items-center justify-center bg-surface px-4">
        <EmptyState
          icon={ended.icon}
          title={ended.title}
          description={ended.description}
        />
      </main>
    );
  const status = statuses[state as keyof typeof statuses];
  return (
    <main className="flex h-dvh flex-col bg-surface-sunken">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle bg-surface px-4">
        <span className="text-sm font-semibold text-fg">Winston</span>
        <div className="flex items-center gap-2">
          <StatusPill tone={status.tone}>
            {desktop?.open ? "Full desktop" : status.label}
          </StatusPill>
          {desktop && (
            <IconButton
              size="sm"
              label={desktop.open ? "Back to the tab" : "Show the full desktop"}
              onClick={desktop.onToggle}
              disabled={state !== "live"}
            >
              {desktop.open ? <AppWindow /> : <Monitor />}
            </IconButton>
          )}
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1 items-start justify-center overflow-hidden">
        {screen}
      </div>
      <footer className="flex shrink-0 items-center gap-3 border-t border-border-subtle bg-surface px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <Button
          className="flex-1"
          onClick={onKeyboard}
          disabled={state !== "live"}
        >
          Keyboard
        </Button>
        <Button
          className="flex-1"
          variant="primary"
          onClick={onDone}
          disabled={state !== "live"}
        >
          Done
        </Button>
        {keyboard}
      </footer>
    </main>
  );
}

const statuses: Record<
  "connecting" | "live" | "reconnecting",
  { tone: StatusTone; label: string }
> = {
  connecting: { tone: "pending", label: "Connecting" },
  live: { tone: "ok", label: "Live" },
  reconnecting: { tone: "attention", label: "Reconnecting" },
};

const endings = {
  ended: {
    icon: <CircleCheck />,
    title: "All done",
    description: "Winston's taking it from here.",
  },
  expired: {
    icon: <Clock />,
    title: "This link expired",
    description: "Ask Winston in Telegram for a new one.",
  },
  invalid: {
    icon: <Link2Off />,
    title: "This link doesn't work",
    description:
      "It may have been opened already. Ask Winston in Telegram for a new one.",
  },
  elsewhere: {
    icon: <MonitorSmartphone />,
    title: "Open somewhere else",
    description: "This live view moved to another tab or device.",
  },
} satisfies Partial<
  Record<LiveState, { icon: ReactNode; title: string; description: string }>
>;
