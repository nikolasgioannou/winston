/**
 * Watches on connected accounts' change feeds (docs/design.md §3, How change
 * notifications arrive). A `watch_connection` job starts or renews one;
 * the renewal sweep queues a job for every watch that's missing or ends
 * within two days (Gmail's last seven).
 */
import { ConnectionUnavailableError } from "@winston/connectors/access-token";
import { ProviderNotFoundError } from "@winston/connectors/errors";
import { gmailSync, WatchRefusedError } from "@winston/connectors/gmail-sync";
import type { DbOrTx } from "@winston/db/client";
import { enqueue } from "@winston/db/queue";
import { connections } from "@winston/db/schema";
import { watchConnectionJob } from "@winston/domain/jobs";
import type { Logger } from "@winston/shared/logger";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { JobHandler } from "../worker.ts";

/** A watch ending sooner than this is renewed. */
export const renewWithinMs = 2 * 24 * 3600_000;

/** How often the sweep looks for watches to renew. */
export const renewSweepMs = 3600_000;

export function watchConnectionHandler(deps: {
  accessToken: (connectionId: string) => Promise<string>;
  /** Where Gmail publishes (`projects/…/topics/gmail-push`); watches are off without it. */
  gmailTopic: string | undefined;
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
      connection?.domain !== "mail" ||
      connection.status === "expired" ||
      connection.status === "disconnected"
    )
      return;
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

/** Queues a watch for each usable mail connection whose watch is missing or ends soon. */
export async function renewWatches(db: DbOrTx, now = new Date()) {
  const due = await db
    .select({ id: connections.id, userId: connections.userId })
    .from(connections)
    .where(
      and(
        eq(connections.domain, "mail"),
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

/** Runs the renewal sweep now and then every hour. */
export function startWatchRenewal(db: DbOrTx, logger: Logger) {
  const sweep = () => {
    renewWatches(db).catch((error: unknown) => {
      logger.error({ err: error }, "renewing watches failed");
    });
  };
  const timer = setInterval(sweep, renewSweepMs);
  sweep();
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
