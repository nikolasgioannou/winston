import {
  defaultAlias,
  defaultCapabilities,
  type ConnectionDomain,
  type ConnectionProvider,
  type ConnectionStatus,
} from "@winston/domain/connections";
import type { TokenVault } from "@winston/shared/token-vault";
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { newId } from "./ids.ts";
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
  alias: string | null;
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
  alias: connections.alias,
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
    alias: row.alias,
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
 * default alias and capabilities, or, for an account the user already
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
    .select({ id: connections.id })
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
    return { connectionId: id, created: false };
  }

  return db.transaction(async (tx) => {
    const aliases = await tx
      .select({ alias: connections.alias })
      .from(connections)
      .where(
        and(
          eq(connections.userId, grant.userId),
          eq(connections.domain, grant.domain),
        ),
      );
    const alias = defaultAlias(
      grant.externalEmail,
      new Set(aliases.flatMap((row) => (row.alias ? [row.alias] : []))),
    );
    await tx.insert(connections).values({
      id,
      userId: grant.userId,
      domain: grant.domain,
      provider: grant.provider,
      externalEmail: grant.externalEmail,
      alias,
      capabilities: defaultCapabilities[grant.domain],
      ...fresh,
    });
    await recordSystemEvent(tx, {
      userId: grant.userId,
      type: "system.app.connected",
      payload: {
        connectionId: id,
        domain: grant.domain,
        provider: grant.provider,
        alias,
        externalEmail: grant.externalEmail,
      },
      sourceRef: `connection:${id}:connected`,
    });
    return { connectionId: id, created: true };
  });
}
