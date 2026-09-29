import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * A small neutral label, e.g. a route or a count. For a state (connected,
 * expiring), use StatusPill instead.
 */
export function Badge({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-md bg-neutral-bg px-1.5 text-xs font-medium whitespace-nowrap text-neutral",
        className,
      )}
    >
      {children}
    </span>
  );
}
