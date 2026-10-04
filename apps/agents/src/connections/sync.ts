/**
 * The `sync_connection` job (docs/design.md §17 event pipeline): queued by a
 * push notification or the reconciliation sweep, one per connection at a
 * time. It turns the provider's changes into events.
 */
import { ConnectionUnavailableError } from "@winston/connectors/access-token";
import { connections } from "@winston/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { JobHandler } from "../worker.ts";
import { matchEvents, type NativeQueryCheck } from "../triggers/matching.ts";
import { queueTimerRefreshes } from "../triggers/timers.ts";
import { syncCalendar, type CalendarSyncDeps } from "./sync-calendar.ts";
import { syncMail, type MailSyncDeps } from "./sync-mail.ts";

type Connection = typeof connections.$inferSelect;

export function syncConnectionHandler(deps: {
  /** The mail provider and change feed for a connection. */
  mail: (connection: Connection) => MailSyncDeps;
  /** The calendar change feed for a connection. */
  calendar: (connection: Connection) => CalendarSyncDeps;
  /** Checks subscriptions' provider-native queries (Gmail search). */
  native?: NativeQueryCheck;
}): JobHandler {
  return async ({ job, db, logger }) => {
    const { connectionId } = z
      .object({ connectionId: z.string() })
      .parse(job.payload);
    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId));
    // Winston's own mailbox isn't synced from anywhere: its mail is pushed to us.
    if (
      !connection ||
      connection.provider === "winston" ||
      connection.status === "expired" ||
      connection.status === "disconnected"
    )
      return;
    try {
      const stored =
        connection.domain === "mail"
          ? await syncMail(db, connection, deps.mail(connection))
          : await syncCalendar(db, connection, deps.calendar(connection));
      // Meetings moved, added or cancelled: heads-up timers follow them.
      if (connection.domain === "calendar" && stored.length > 0)
        await queueTimerRefreshes(db, connection.userId);
      const matched = await matchEvents(db, stored, {
        ...(deps.native ? { native: deps.native } : {}),
        logger,
      });
      logger.info(
        {
          connectionId,
          domain: connection.domain,
          events: stored.length,
          matched,
        },
        "synced",
      );
    } catch (error) {
      // The account needs the user first; the grant sweep has told Winston.
      if (error instanceof ConnectionUnavailableError) return;
      throw error;
    }
  };
}
