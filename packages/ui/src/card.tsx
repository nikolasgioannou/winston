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

/**
 * A card whose rows are links (like the connected accounts list): each row
 * spans the card edge to edge, so its hover wash fills the row, and the card
 * clips it to its corners. Style each row with `linkCardRow`.
 */
export function LinkCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-xl bg-surface-raised shadow-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A `LinkCard` row: a hover wash and hairline dividers inset to the content.
 * Each divider is drawn by the row below it, so a hovered (or focused) row
 * hides its own and the next row's, and the wash meets the rows around it
 * cleanly, as in Linear. Only rows after the first style `::before`: an
 * empty one on the first row would join its flex layout and shift it.
 */
export const linkCardRow =
  "relative flex items-center gap-3 px-4 py-3.5 outline-none transition-[background-color] duration-100 hover:bg-hover focus-visible:bg-hover not-first:before:absolute not-first:before:inset-x-4 not-first:before:top-0 not-first:before:h-px not-first:before:bg-border-subtle not-first:hover:before:opacity-0 not-first:focus-visible:before:opacity-0 [:hover+&]:before:opacity-0 [:focus-visible+&]:before:opacity-0";
