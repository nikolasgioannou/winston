/**
 * Gmail's change feed (docs/design.md §3, How change notifications arrive):
 * `users.watch` makes Gmail publish "something changed" to our Pub/Sub
 * topic, and `users.stop` ends it. Watches last 7 days and are renewed.
 */
import { ProviderNotFoundError, ProviderUnavailableError } from "./errors.ts";

const api = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Gmail refused the watch for a reason retrying won't fix (no such topic, no permission). */
export class WatchRefusedError extends Error {
  override name = "WatchRefusedError";
}

export function gmailSync({
  accessToken,
  fetch: send = fetch,
}: {
  accessToken: () => Promise<string>;
  fetch?: typeof fetch;
}) {
  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await send(`${api}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (response.status === 429 || response.status >= 500)
      throw new ProviderUnavailableError(
        `Gmail is busy (${String(response.status)}).`,
      );
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      const message = `Gmail said ${String(response.status)}: ${error.error?.message ?? "no details"}`;
      if (response.status === 404) throw new ProviderNotFoundError(message);
      if (response.status === 400 || response.status === 403)
        throw new WatchRefusedError(message);
      throw new Error(message);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  return {
    /**
     * Starts (or renews) the account's watch: changes to the inbox and sent
     * mail, labels included, published to `topic`. Returns where history
     * stands now and when the watch ends.
     */
    async watch(topic: string) {
      const result = await post<{ historyId: string; expiration: string }>(
        "/watch",
        {
          topicName: topic,
          labelIds: ["INBOX", "SENT"],
          labelFilterBehavior: "INCLUDE",
        },
      );
      return {
        historyId: result.historyId,
        expiresAt: new Date(Number(result.expiration)),
      };
    },
    /** Ends the account's watch. */
    async stop() {
      await post("/stop", {});
    },
  };
}
