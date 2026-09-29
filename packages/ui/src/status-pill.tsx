import type { ReactNode } from "react";
import { cn } from "./cn";

/** The states Winston reports: all good, needs the user, broken, in progress, or idle. */
export type StatusTone = "ok" | "attention" | "error" | "pending" | "neutral";

const tones: Record<StatusTone, { pill: string; dot: string }> = {
  ok: { pill: "bg-ok-bg text-ok", dot: "bg-ok-dot" },
  attention: {
    pill: "bg-attention-bg text-attention",
    dot: "bg-attention-dot",
  },
  error: { pill: "bg-error-bg text-error", dot: "bg-error-dot" },
  pending: { pill: "bg-pending-bg text-pending", dot: "bg-pending-dot" },
  neutral: { pill: "bg-neutral-bg text-neutral", dot: "bg-neutral-dot" },
};

// Notion's status property pill: a tinted rounded label with a colored dot.
export function StatusPill({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: ReactNode;
  className?: string;
}) {
  const { pill, dot } = tones[tone];
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap",
        pill,
        className,
      )}
    >
      <span className={cn("size-2 rounded-full", dot)} aria-hidden />
      {children}
    </span>
  );
}
