import type { DbOrTx } from "@winston/db/client";
import { connections } from "@winston/db/schema";
import { recordSystemEvent } from "@winston/db/system-events";
import type { Logger } from "@winston/shared/logger";
import { and, eq, inArray, lte } from "drizzle-orm";

/**
 * Winston's Google app stays in testing mode, so a connection's refresh token
 * dies 7 days after it's granted (docs/design.md §12a). The user is warned a
 * day ahead.
 */
export const grantLifetimeMs = 7 * 24 * 60 * 60_000;
export const warnBeforeMs = 24 * 60 * 60_000;

type Connection = Pick<
  typeof connections.$inferSelect,
  "id" | "userId" | "domain" | "provider" | "externalEmail" | "grantedAt"
>;

/** Makes each connection's one-tap reconnect link. */
export type ReconnectUrl = (connectionId: string) => string;

export const reconnectUrlFor =
  (webPublicUrl: string): ReconnectUrl =>
  (connectionId) =>
    new URL(
      `/auth/google/connect?reconnect=${connectionId}`,
      webPublicUrl,
    ).toString();

const columns = {
  id: connections.id,
  userId: connections.userId,
  domain: connections.domain,
  provider: connections.provider,
  externalEmail: connections.externalEmail,
  grantedAt: connections.grantedAt,
};

/**
 * Tells Winston about a grant running out, once per grant: the source ref
 * names the grant, so a repeat (another sweep, a failed refresh after the
 * sweep) is ignored.
 */
async function recordGrantEvent(
  db: DbOrTx,
  type: "system.app.auth_expiring" | "system.app.auth_expired",
  connection: Connection,
  reconnectUrl: ReconnectUrl,
) {
  await recordSystemEvent(db, {
    userId: connection.userId,
    type,
    payload: {
      connectionId: connection.id,
      domain: connection.domain,
      provider: connection.provider,
      externalEmail: connection.externalEmail,
      expiresAt: new Date(
        connection.grantedAt.getTime() + grantLifetimeMs,
      ).toISOString(),
      reconnectUrl: reconnectUrl(connection.id),
    },
    sourceRef: `connection:${connection.id}:${type}:${String(connection.grantedAt.getTime())}`,
  });
}

/**
 * Marks a connection `expired` (its grant ran out, or Google refused it with
 * `invalid_grant`) and tells Winston, unless it's already expired or
 * disconnected.
 */
export async function markExpired(
  db: DbOrTx,
  connectionId: string,
  reconnectUrl: ReconnectUrl,
) {
  const [expired] = await db
    .update(connections)
    .set({ status: "expired" })
    .where(
      and(
        eq(connections.id, connectionId),
        inArray(connections.status, ["ok", "expiring"]),
      ),
    )
    .returning(columns);
  if (expired)
    await recordGrantEvent(
      db,
      "system.app.auth_expired",
      expired,
      reconnectUrl,
    );
  return expired !== undefined;
}

/**
 * Moves connections whose grants are running out: `expiring` from a day
 * before the 7 days are up, `expired` after. Each move tells Winston once.
 */
export async function sweepConnectionGrants(
  db: DbOrTx,
  logger: Logger,
  {
    reconnectUrl,
    now = new Date(),
  }: { reconnectUrl: ReconnectUrl; now?: Date },
) {
  const expiredBefore = new Date(now.getTime() - grantLifetimeMs);
  const expiringBefore = new Date(
    now.getTime() - grantLifetimeMs + warnBeforeMs,
  );

  const due = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        inArray(connections.status, ["ok", "expiring"]),
        lte(connections.grantedAt, expiredBefore),
      ),
    );
  for (const { id } of due) {
    await markExpired(db, id, reconnectUrl);
    logger.info({ connectionId: id }, "connection's grant expired");
  }

  const expiring = await db
    .update(connections)
    .set({ status: "expiring" })
    .where(
      and(
        eq(connections.status, "ok"),
        lte(connections.grantedAt, expiringBefore),
      ),
    )
    .returning(columns);
  for (const connection of expiring) {
    await recordGrantEvent(
      db,
      "system.app.auth_expiring",
      connection,
      reconnectUrl,
    );
    logger.info(
      { connectionId: connection.id },
      "connection's grant expires soon",
    );
  }
}
