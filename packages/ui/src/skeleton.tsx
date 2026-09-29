import { cn } from "./cn";

/**
 * A placeholder block while content loads, shaped like what's coming. It
 * pulses gently, and stays still for people who prefer reduced motion.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "animate-pulse rounded-md bg-surface-strong motion-reduce:animate-none",
        className,
      )}
    />
  );
}
