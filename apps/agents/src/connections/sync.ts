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
import { syncMail, type MailSyncDeps } from "./sync-mail.ts";

type Connection = typeof connections.$inferSelect;

export function syncConnectionHandler(deps: {
  /** The mail provider and change feed for a connection. */
  mail: (connection: Connection) => MailSyncDeps;
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
    try {
      if (connection.domain === "mail") {
        const stored = await syncMail(db, connection, deps.mail(connection));
        logger.info({ connectionId, events: stored.length }, "synced mail");
      }
    } catch (error) {
      // The account needs the user first; the grant sweep has told Winston.
      if (error instanceof ConnectionUnavailableError) return;
      throw error;
    }
  };
}
