/**
 * Gmail's change feed (docs/design.md §3, How change notifications arrive):
 * `users.watch` makes Gmail publish "something changed" to our Pub/Sub
 * topic, and `users.stop` ends it. Watches last 7 days and are renewed.
 */
import { ProviderNotFoundError, ProviderUnavailableError } from "./errors.ts";

const api = "https://gmail.googleapis.com/gmail/v1/users/me";

/** The stored history id is too old for Gmail to answer from; a bounded resync is needed. */
export class HistoryExpiredError extends Error {
  override name = "HistoryExpiredError";
}

/** A message as a history record names it. */
export interface HistoryMessage {
  id: string;
  threadId: string;
  labelIds?: string[] | undefined;
}

/** One record of the mailbox's history (only the kinds we ask for). */
export interface HistoryRecord {
  id: string;
  messagesAdded?: { message: HistoryMessage }[] | undefined;
  labelsAdded?: { message: HistoryMessage; labelIds: string[] }[] | undefined;
  labelsRemoved?: { message: HistoryMessage; labelIds: string[] }[] | undefined;
}

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
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const response = await send(`${api}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
      const result = await request<{ historyId: string; expiration: string }>(
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
    /**
     * Every change since `startHistoryId` (new messages and label changes),
     * oldest first, and where history stands now. Throws
     * `HistoryExpiredError` when Gmail no longer has history that old.
     */
    async history(startHistoryId: string) {
      const records: HistoryRecord[] = [];
      let pageToken: string | undefined;
      let historyId: string;
      do {
        const query = new URLSearchParams({
          startHistoryId,
          maxResults: "500",
          ...(pageToken ? { pageToken } : {}),
        });
        for (const type of ["messageAdded", "labelAdded", "labelRemoved"])
          query.append("historyTypes", type);
        let page: {
          history?: HistoryRecord[];
          nextPageToken?: string;
          historyId: string;
        };
        try {
          page = await request(`/history?${query.toString()}`);
        } catch (error) {
          if (error instanceof ProviderNotFoundError)
            throw new HistoryExpiredError(
              `Gmail has no history from ${startHistoryId} any more.`,
            );
          throw error;
        }
        records.push(...(page.history ?? []));
        historyId = page.historyId;
        pageToken = page.nextPageToken;
      } while (pageToken);
      return { records, historyId };
    },
    /** Where the mailbox's history stands now. */
    async currentHistoryId() {
      return (await request<{ historyId: string }>("/profile")).historyId;
    },
    /** Messages from the last `days` days with their labels, for a resync. */
    async recentMessages(days: number) {
      const listed = await request<{ messages?: { id: string }[] }>(
        `/messages?${new URLSearchParams({ q: `newer_than:${String(days)}d`, maxResults: "100" }).toString()}`,
      );
      const messages: HistoryMessage[] = [];
      for (const { id } of listed.messages ?? [])
        messages.push(
          await request<HistoryMessage>(`/messages/${id}?format=minimal`),
        );
      return messages;
    },
    /** The account's user labels: id to name. */
    async labelNames() {
      const { labels = [] } = await request<{
        labels?: { id: string; name: string; type: string }[];
      }>("/labels");
      return new Map(
        labels.filter((l) => l.type === "user").map((l) => [l.id, l.name]),
      );
    },
    /** Ends the account's watch. */
    async stop() {
      await request("/stop", {});
    },
  };
}
