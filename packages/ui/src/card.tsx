import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * A raised panel holding related content. Each direct child is a block,
 * separated by hairline dividers inset to the content's edges.
 */
export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col divide-y divide-border-subtle rounded-xl bg-surface-raised px-4 shadow-sm *:py-3.5",
        className,
      )}
    >
      {children}
    </div>
  );
}
