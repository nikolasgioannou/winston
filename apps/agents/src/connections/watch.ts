/**
 * Watches on connected accounts' change feeds (docs/design.md §3, How change
 * notifications arrive): a Gmail watch per mail account, and a Google
 * Calendar channel per watched calendar of a calendar account. A
 * `watch_connection` job starts or renews them; reconciliation (every 10
 * minutes) queues one for every account whose watch is missing or ends within
 * two days.
 * `connections.watch_expires_at` is the soonest end.
 */
import {
  ConnectionUnavailableError,
  refreshGoogleToken,
} from "@winston/connectors/access-token";
import { googleCalendarSync } from "@winston/connectors/google-calendar-sync";
import { ProviderNotFoundError } from "@winston/connectors/errors";
import { gmailSync, WatchRefusedError } from "@winston/connectors/gmail-sync";
import type { DbOrTx } from "@winston/db/client";
import { enqueue } from "@winston/db/queue";
import { calendarChannels, connections } from "@winston/db/schema";
import { watchConnectionJob } from "@winston/domain/jobs";
import type { Logger } from "@winston/shared/logger";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { JobHandler } from "../worker.ts";

/** A watch ending sooner than this is renewed. */
export const renewWithinMs = 2 * 24 * 3600_000;

/** How long a new calendar channel is asked to last; Google may grant less. */
export const channelTtlSeconds = 7 * 24 * 3600;

const sha256 = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

export function watchConnectionHandler(deps: {
  accessToken: (connectionId: string) => Promise<string>;
  /** Where Gmail publishes (`projects/…/topics/gmail-push`); mail isn't watched without it. */
  gmailTopic: string | undefined;
  /** Our calendar webhook (`https://api…/webhooks/calendar`); calendars aren't watched without it. */
  calendarAddress: string | undefined;
  fetch?: typeof fetch;
}): JobHandler {
  return async ({ job, db, logger }) => {
    const { connectionId } = z
      .object({ connectionId: z.string() })
      .parse(job.payload);
    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId));
    if (
      !connection ||
      connection.status === "expired" ||
      connection.status === "disconnected"
    )
      return;
    if (connection.domain === "calendar") {
      await watchCalendars(db, connection, deps, logger);
      return;
    }
    if (!deps.gmailTopic) {
      logger.info("GMAIL_PUSH_TOPIC isn't set; not watching mail");
      return;
    }
    const sync = gmailSync({
      accessToken: () => deps.accessToken(connectionId),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    try {
      const watch = await sync.watch(deps.gmailTopic);
      await db
        .update(connections)
        .set({
          watchExpiresAt: watch.expiresAt,
          // Sync starts from here the first time; after that it keeps its own place.
          syncState: sql`coalesce(${connections.syncState}, ${JSON.stringify({ historyId: watch.historyId })}::jsonb)`,
        })
        .where(eq(connections.id, connectionId));
      logger.info(
        { connectionId, expiresAt: watch.expiresAt },
        "watching mail",
      );
    } catch (error) {
      // Not worth retrying: the account can't be used, or the topic isn't set up.
      if (
        error instanceof ConnectionUnavailableError ||
        error instanceof WatchRefusedError ||
        error instanceof ProviderNotFoundError
      ) {
        logger.warn({ err: error, connectionId }, "couldn't watch mail");
        return;
      }
      throw error;
    }
  };
}

/**
 * Keeps a channel on each calendar the account's lists cover: a channel
 * ending within two days is replaced by a new one first and stopped after,
 * so notifications never have a gap; channels on calendars no longer
 * covered are stopped.
 */
async function watchCalendars(
  db: DbOrTx,
  connection: typeof connections.$inferSelect,
  deps: Parameters<typeof watchConnectionHandler>[0],
  logger: Logger,
  now = new Date(),
) {
  if (!deps.calendarAddress) {
    logger.info("CALENDAR_PUSH_URL isn't set; not watching calendars");
    return;
  }
  const sync = googleCalendarSync({
    accessToken: () => deps.accessToken(connection.id),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  try {
    const watched = await sync.watchedCalendars();
    const existing = await db
      .select()
      .from(calendarChannels)
      .where(eq(calendarChannels.connectionId, connection.id));
    const renewBy = new Date(now.getTime() + renewWithinMs);
    const retired: typeof existing = [];
    for (const calendarId of watched) {
      const current = existing.filter((c) => c.calendarId === calendarId);
      if (current.some((c) => c.expiresAt > renewBy)) {
        retired.push(...current.filter((c) => c.expiresAt <= renewBy));
        continue;
      }
      const id = crypto.randomUUID();
      const token = Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString("base64url");
      const channel = await sync.watch(calendarId, {
        id,
        token,
        address: deps.calendarAddress,
        ttlSeconds: channelTtlSeconds,
      });
      await db.insert(calendarChannels).values({
        id,
        connectionId: connection.id,
        calendarId,
        resourceId: channel.resourceId,
        tokenHash: sha256(token),
        expiresAt: channel.expiresAt,
      });
      retired.push(...current);
    }
    retired.push(...existing.filter((c) => !watched.includes(c.calendarId)));
    // The new channels are live; now the old ones can go.
    for (const channel of retired) {
      await sync.stopChannel(channel.id, channel.resourceId);
      await db
        .delete(calendarChannels)
        .where(eq(calendarChannels.id, channel.id));
    }
    const [soonest] = await db
      .select({ at: sql<Date | null>`min(${calendarChannels.expiresAt})` })
      .from(calendarChannels)
      .where(eq(calendarChannels.connectionId, connection.id));
    await db
      .update(connections)
      .set({ watchExpiresAt: soonest?.at ? new Date(soonest.at) : null })
      .where(eq(connections.id, connection.id));
    logger.info(
      {
        connectionId: connection.id,
        calendars: watched.length,
        stopped: retired.length,
      },
      "watching calendars",
    );
  } catch (error) {
    if (
      error instanceof ConnectionUnavailableError ||
      error instanceof WatchRefusedError
    ) {
      logger.warn(
        { err: error, connectionId: connection.id },
        "couldn't watch calendars",
      );
      return;
    }
    throw error;
  }
}

/**
 * Stops an account's watches with its refresh token, before the token goes
 * (on disconnect): the Gmail watch, or every calendar channel.
 */
export function watchStopper(
  db: DbOrTx,
  client: { clientId: string; clientSecret: string },
  send: typeof fetch = fetch,
) {
  return async (
    connection: { id: string; domain: string },
    refreshToken: string,
  ) => {
    const token = await refreshGoogleToken(refreshToken, client, send);
    // A grant that's already gone has no watch left to stop.
    if (token === "invalid_grant") return;
    const accessToken = () => Promise.resolve(token.access_token);
    if (connection.domain === "mail") {
      await gmailSync({ accessToken, fetch: send }).stop();
      return;
    }
    const sync = googleCalendarSync({ accessToken, fetch: send });
    const channels = await db
      .select()
      .from(calendarChannels)
      .where(eq(calendarChannels.connectionId, connection.id));
    for (const channel of channels) {
      await sync.stopChannel(channel.id, channel.resourceId);
      await db
        .delete(calendarChannels)
        .where(eq(calendarChannels.id, channel.id));
    }
  };
}

/** Queues a watch for each usable connection whose watch is missing or ends soon. */
export async function renewWatches(db: DbOrTx, now = new Date()) {
  const due = await db
    .select({ id: connections.id, userId: connections.userId })
    .from(connections)
    .where(
      and(
        inArray(connections.status, ["ok", "expiring"]),
        or(
          isNull(connections.watchExpiresAt),
          lt(
            connections.watchExpiresAt,
            new Date(now.getTime() + renewWithinMs),
          ),
        ),
      ),
    );
  for (const connection of due)
    await enqueue(db, watchConnectionJob.type, {
      userId: connection.userId,
      payload: { connectionId: connection.id },
      dedupeKey: watchConnectionJob.dedupeKey(connection.id),
    });
  return due.length;
}
