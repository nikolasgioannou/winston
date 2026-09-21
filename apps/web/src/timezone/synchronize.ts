import { timezoneProfileSchema, validTimezone } from "@winston/contracts/timezone";

export async function synchronizeTimezone(signal: AbortSignal) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch("/api/owner/timezone", { signal });

    if (!response.ok) {
      return;
    }

    const parsed = timezoneProfileSchema.safeParse(await response.json());

    if (!parsed.success || document.visibilityState !== "visible") {
      return;
    }

    // Observe after each revision read, including a conflict retry, rather than reusing stale tab state.
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    if (!validTimezone(timezone)) {
      return;
    }
    if (parsed.data.timezone === timezone && parsed.data.source === "browser") {
      return;
    }

    signal.throwIfAborted();
    const updated = await fetch("/api/owner/timezone", {
      method: "PUT",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone, revision: parsed.data.revision }),
    });

    if (updated.status !== 409) {
      return;
    }
  }
}
