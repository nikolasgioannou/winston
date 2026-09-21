import { useEffect } from "react";
import { synchronizeTimezone } from "./synchronize";

export function useTimezone(authenticated: boolean) {
  useEffect(() => {
    if (!authenticated) {
      return;
    }

    const lifetime = new AbortController();
    let running = false;

    function refresh() {
      if (running || document.visibilityState !== "visible") {
        return;
      }

      running = true;
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]);

      synchronizeTimezone(signal)
        .catch(() => {
          // Preserve the last valid profile; the next foreground event will try again.
        })
        .finally(() => {
          running = false;
        });
    }

    refresh();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);

    return () => {
      lifetime.abort();
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
    };
  }, [authenticated]);
}
