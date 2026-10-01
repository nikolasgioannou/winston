import {
  defaultCapabilities,
  isCapabilityOf,
  type ConnectionDomain,
  type ConnectionProvider,
  type ConnectionStatus,
} from "@winston/domain/connections";
import { revokeConnectionTokenJob } from "@winston/domain/jobs";
import type { TokenVault } from "@winston/shared/token-vault";
import { and, eq, ne, sql } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { newId } from "./ids.ts";
import { enqueue } from "./queue.ts";
import { connections } from "./schema/index.ts";
import { recordSystemEvent } from "./system-events.ts";

type ConnectionRow = typeof connections.$inferSelect;

/**
 * A connected account as it may leave the backend (docs/design.md §7,
 * explicit DTOs): everything but the token and sync internals.
 */
export interface ConnectionDto {
  id: string;
  domain: ConnectionRow["domain"];
  provider: ConnectionRow["provider"];
  externalEmail: string;
  scopes: string[];
  capabilities: ConnectionRow["capabilities"];
  grantedAt: string;
  status: ConnectionStatus;
  createdAt: string;
}

/**
 * The columns a `ConnectionDto` needs, for `db.select(connectionDtoColumns)`,
 * so the ciphertext isn't even read.
 */
export const connectionDtoColumns = {
  id: connections.id,
  domain: connections.domain,
  provider: connections.provider,
  externalEmail: connections.externalEmail,
  scopes: connections.scopes,
  capabilities: connections.capabilities,
  grantedAt: connections.grantedAt,
  status: connections.status,
  createdAt: connections.createdAt,
};

/**
 * Builds the DTO field by field, so a whole row passed in by mistake still
 * can't carry its token out.
 */
export function toConnectionDto(
  row: Pick<ConnectionRow, keyof typeof connectionDtoColumns>,
): ConnectionDto {
  return {
    id: row.id,
    domain: row.domain,
    provider: row.provider,
    externalEmail: row.externalEmail,
    scopes: row.scopes,
    capabilities: row.capabilities,
    grantedAt: row.grantedAt.toISOString(),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The vault context a connection's token is sealed with. */
export const tokenContext = (connectionId: string) => ({ connectionId });

/**
 * Stores a new grant (docs/design.md §12a): a new connection with the
 * default capabilities, or, for an account the user already
 * connected in this domain, fresh tokens and scopes on the same connection.
 * The refresh token is sealed with the connection's id as context. A new
 * connection also tells Winston (`system.app.connected`).
 */
export async function saveConnection(
  db: DbOrTx,
  vault: TokenVault,
  grant: {
    userId: string;
    domain: ConnectionDomain;
    provider: ConnectionProvider;
    externalEmail: string;
    scopes: string[];
    refreshToken: string;
  },
) {
  const [existing] = await db
    .select({ id: connections.id, status: connections.status })
    .from(connections)
    .where(
      and(
        eq(connections.userId, grant.userId),
        eq(connections.domain, grant.domain),
        eq(connections.externalEmail, grant.externalEmail),
      ),
    );
  const id = existing?.id ?? newId("connection");
  const tokenCiphertext = await vault.encrypt(
    grant.refreshToken,
    tokenContext(id),
  );
  const fresh = {
    scopes: grant.scopes,
    tokenCiphertext,
    grantedAt: new Date(),
    status: "ok" as const,
  };
  if (existing) {
    await db.update(connections).set(fresh).where(eq(connections.id, id));
    // Coming back after a disconnect is news to Winston; a refresh isn't.
    if (existing.status === "disconnected")
      await recordConnected(
        db,
        grant.userId,
        id,
        `reconnected:${String(Date.now())}`,
      );
    return { connectionId: id, created: false };
  }

  return db.transaction(async (tx) => {
    await tx.insert(connections).values({
      id,
      userId: grant.userId,
      domain: grant.domain,
      provider: grant.provider,
      externalEmail: grant.externalEmail,
      capabilities: defaultCapabilities[grant.domain],
      ...fresh,
    });
    await recordConnected(tx, grant.userId, id, "connected");
    return { connectionId: id, created: true };
  });
}

/** What Winston is told about a connection (`system.app.connected` and `…disconnected`). */
async function connectionFacts(db: DbOrTx, connectionId: string) {
  const [facts] = await db
    .select({
      connectionId: connections.id,
      domain: connections.domain,
      provider: connections.provider,
      externalEmail: connections.externalEmail,
    })
    .from(connections)
    .where(eq(connections.id, connectionId));
  if (!facts) throw new Error(`No connection ${connectionId}`);
  return facts;
}

async function recordConnected(
  db: DbOrTx,
  userId: string,
  connectionId: string,
  occasion: string,
) {
  await recordSystemEvent(db, {
    userId,
    type: "system.app.connected",
    payload: await connectionFacts(db, connectionId),
    sourceRef: `connection:${connectionId}:${occasion}`,
  });
}

const ownedBy = (userId: string, connectionId: string) =>
  and(eq(connections.id, connectionId), eq(connections.userId, userId));

/**
 * Turns one capability of a user's connection on or off (the toggles M5
 * enforces). The stored map always names every capability of the domain.
 * Returns the new map, or undefined if there's no such connection or the
 * capability isn't its domain's.
 */
export async function setCapability(
  db: DbOrTx,
  userId: string,
  connectionId: string,
  capability: string,
  enabled: boolean,
) {
  const [connection] = await db
    .select({ domain: connections.domain })
    .from(connections)
    .where(ownedBy(userId, connectionId));
  if (!connection || !isCapabilityOf(connection.domain, capability))
    return undefined;
  const [updated] = await db
    .update(connections)
    .set({
      capabilities: sql`${connections.capabilities} || jsonb_build_object(${capability}::text, ${enabled}::boolean)`,
    })
    .where(ownedBy(userId, connectionId))
    .returning({ capabilities: connections.capabilities });
  return updated?.capabilities;
}

/**
 * Disconnects a user's connection: it's `disconnected` at once, so nothing
 * uses it again, Winston is told (`system.app.disconnected`), and a job in
 * `agents` deals with the Google grant. Returns false if there's no such
 * connection or it's already disconnected.
 */
export async function disconnectConnection(
  db: DbOrTx,
  userId: string,
  connectionId: string,
) {
  return db.transaction(async (tx) => {
    const [disconnected] = await tx
      .update(connections)
      .set({ status: "disconnected" })
      .where(
        and(
          ownedBy(userId, connectionId),
          ne(connections.status, "disconnected"),
        ),
      )
      .returning({ id: connections.id });
    if (!disconnected) return false;
    // M7: cancel the triggers scoped to this connection here, in the same
    // transaction (docs/design.md §3, system.app.disconnected).
    await recordSystemEvent(tx, {
      userId,
      type: "system.app.disconnected",
      payload: await connectionFacts(tx, connectionId),
      sourceRef: `connection:${connectionId}:disconnected:${String(Date.now())}`,
    });
    await enqueue(tx, revokeConnectionTokenJob.type, {
      userId,
      payload: { connectionId },
      dedupeKey: revokeConnectionTokenJob.dedupeKey(connectionId),
    });
    return true;
  });
}
