import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * Re-runs the page's loaders every few seconds while `active`, for state that
 * changes elsewhere: a computer setting up, a Telegram chat being linked.
 * Polling is simple and fine at this scale (docs/design.md §17).
 */
export function useReloadWhile(active: boolean, intervalMs = 3_000) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void router.invalidate(), intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [active, intervalMs, router]);
}
