/**
 * Google Calendar's change feed (docs/design.md §3, How change notifications
 * arrive): an `events.watch` channel per watched calendar pushes "something
 * changed" straight to our webhook, with a token we check.
 */
import { listedCalendars, type GoogleEvent } from "./google-calendar.ts";
import { ProviderNotFoundError, ProviderUnavailableError } from "./errors.ts";
import { WatchRefusedError } from "./gmail-sync.ts";

const api = "https://www.googleapis.com/calendar/v3";

/** Google no longer accepts the stored sync token (410): a full resync is needed. */
export class SyncTokenExpiredError extends Error {
  override name = "SyncTokenExpiredError";
}

export function googleCalendarSync({
  accessToken,
  fetch: send = fetch,
}: {
  accessToken: () => Promise<string>;
  fetch?: typeof fetch;
}) {
  async function request<T>(
    path: string,
    options: { body?: unknown; query?: Record<string, string> } = {},
  ): Promise<T> {
    const query = options.query
      ? `?${new URLSearchParams(options.query).toString()}`
      : "";
    const response = await send(`${api}${path}${query}`, {
      method: options.body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    if (response.status === 429 || response.status >= 500)
      throw new ProviderUnavailableError(
        `Google Calendar is busy (${String(response.status)}).`,
      );
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      const message = `Google Calendar said ${String(response.status)}: ${error.error?.message ?? "no details"}`;
      if (response.status === 410) throw new SyncTokenExpiredError(message);
      if (response.status === 404) throw new ProviderNotFoundError(message);
      if (response.status === 400 || response.status === 403)
        throw new WatchRefusedError(message);
      throw new Error(message);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  return {
    /** The calendars to watch: the ones a list covers. */
    async watchedCalendars() {
      const { items = [] } = await request<{
        items?: {
          id: string;
          primary?: boolean;
          accessRole?: string;
          selected?: boolean;
        }[];
      }>("/users/me/calendarList", {
        query: { minAccessRole: "freeBusyReader" },
      });
      return listedCalendars(
        items.map((c) => ({
          id: c.id,
          primary: c.primary === true,
          selected: c.selected === true,
          readable: c.accessRole !== "freeBusyReader",
        })),
      ).map((c) => c.id);
    },
    /**
     * Opens a channel on a calendar's events. Google caps its lifetime; the
     * returned expiry is what it granted.
     */
    async watch(
      calendarId: string,
      channel: {
        id: string;
        token: string;
        address: string;
        ttlSeconds: number;
      },
    ) {
      const result = await request<{ resourceId: string; expiration: string }>(
        `/calendars/${encodeURIComponent(calendarId)}/events/watch`,
        {
          body: {
            id: channel.id,
            type: "web_hook",
            address: channel.address,
            token: channel.token,
            params: { ttl: String(channel.ttlSeconds) },
          },
        },
      );
      return {
        resourceId: result.resourceId,
        expiresAt: new Date(Number(result.expiration)),
      };
    },
    /**
     * A calendar's changes: since `syncToken` (deleted events come back
     * `cancelled`), or, for a first or full sync, every event ending after
     * `since`. Series come as one event and changed instances separately
     * (no expansion). Returns the token for next time, from the last page.
     * Throws `SyncTokenExpiredError` when Google refuses the token.
     */
    async changes(
      calendarId: string,
      from: { syncToken: string } | { since: Date },
    ) {
      const events: GoogleEvent[] = [];
      let pageToken: string | undefined;
      let nextSyncToken: string | undefined;
      do {
        const page = await request<{
          items?: GoogleEvent[];
          nextPageToken?: string;
          nextSyncToken?: string;
        }>(`/calendars/${encodeURIComponent(calendarId)}/events`, {
          query: {
            maxResults: "2500",
            ...("syncToken" in from
              ? { syncToken: from.syncToken }
              : { timeMin: from.since.toISOString() }),
            ...(pageToken ? { pageToken } : {}),
          },
        });
        events.push(...(page.items ?? []));
        pageToken = page.nextPageToken;
        nextSyncToken = page.nextSyncToken;
      } while (pageToken);
      if (!nextSyncToken)
        throw new Error(
          `Google Calendar gave no sync token for ${calendarId}.`,
        );
      return { events, nextSyncToken };
    },
    /** Stops a channel; one that's already gone is fine. */
    async stopChannel(id: string, resourceId: string) {
      try {
        await request("/channels/stop", { body: { id, resourceId } });
      } catch (error) {
        if (!(error instanceof ProviderNotFoundError)) throw error;
      }
    },
  };
}
