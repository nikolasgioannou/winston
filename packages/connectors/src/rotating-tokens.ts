/**
 * Access tokens for connections whose refresh tokens rotate (52bf55,
 * docs/design.md §5): each refresh returns a new refresh token and spends the
 * old one, so two services refreshing at once would replay a spent token, and
 * the provider may revoke the whole grant. Refreshing takes a row lock on the
 * connection, re-reads what's stored, and stores the new refresh token and
 * the access token (both sealed) before the lock goes, so the gateway and
 * agents share one access token and only one of them refreshes.
 */
import type { DbOrTx } from "@winston/db/client";
import { accessTokenContext, tokenContext } from "@winston/db/connections";
import { connections } from "@winston/db/schema";
import type { TokenVault } from "@winston/shared/token-vault";
import { eq } from "drizzle-orm";
import { ConnectionUnavailableError } from "./access-token.ts";
import { markExpired, type ReconnectUrl } from "./grants.ts";

/** An access token this close to expiring is refreshed rather than used. */
const refreshBeforeMs = 60_000;

/** What a provider's token endpoint gave back for a refresh. */
export interface RefreshedTokens {
  accessToken: string;
  /** The access token's lifetime, in seconds. */
  expiresIn: number;
  /** The new refresh token; the old one is spent. Absent if it didn't rotate. */
  refreshToken?: string;
}

/**
 * Trades a refresh token at the provider. Returns "invalid_grant" when the
 * grant is gone (expired, revoked, or a spent token was replayed).
 */
export type RefreshTokens = (
  refreshToken: string,
) => Promise<RefreshedTokens | "invalid_grant">;

interface Held {
  token: string;
  expiresAt: number;
}

export function rotatingAccessTokens({
  db,
  vault,
  refresh,
  reconnectUrl,
  now = () => Date.now(),
}: {
  db: DbOrTx;
  vault: TokenVault;
  refresh: RefreshTokens;
  reconnectUrl: ReconnectUrl;
  now?: () => number;
}) {
  const cache = new Map<string, Held>();
  const usable = (held: Held | undefined, rejected?: string) =>
    held !== undefined &&
    held.token !== rejected &&
    held.expiresAt - refreshBeforeMs > now();

  /** The access token stored on a connection, if there is one. */
  const storedToken = async (
    connectionId: string,
    row: {
      accessTokenCiphertext: string | null;
      accessTokenExpiresAt: Date | null;
    },
  ): Promise<Held | undefined> =>
    row.accessTokenCiphertext && row.accessTokenExpiresAt
      ? {
          token: await vault.decrypt(
            row.accessTokenCiphertext,
            accessTokenContext(connectionId),
          ),
          expiresAt: row.accessTokenExpiresAt.getTime(),
        }
      : undefined;

  /** The stored access token if it's still good, or a fresh one; under the row lock. */
  const refreshed = (connectionId: string, rejected?: string) =>
    db.transaction(async (tx): Promise<Held | "expired"> => {
      const [row] = await tx
        .select()
        .from(connections)
        .where(eq(connections.id, connectionId))
        .for("update");
      if (!row) throw new Error(`No connection ${connectionId}`);
      if (row.status === "expired" || row.status === "disconnected")
        return "expired";
      // Another service may have refreshed while this one waited for the lock.
      const stored = await storedToken(connectionId, row);
      if (stored && usable(stored, rejected)) return stored;
      if (!row.tokenCiphertext) return "expired";

      const fresh = await refresh(
        await vault.decrypt(row.tokenCiphertext, tokenContext(connectionId)),
      );
      if (fresh === "invalid_grant") {
        await markExpired(tx, connectionId, reconnectUrl);
        return "expired";
      }
      const expiresAt = now() + fresh.expiresIn * 1000;
      await tx
        .update(connections)
        .set({
          ...(fresh.refreshToken
            ? {
                tokenCiphertext: await vault.encrypt(
                  fresh.refreshToken,
                  tokenContext(connectionId),
                ),
              }
            : {}),
          accessTokenCiphertext: await vault.encrypt(
            fresh.accessToken,
            accessTokenContext(connectionId),
          ),
          accessTokenExpiresAt: new Date(expiresAt),
        })
        .where(eq(connections.id, connectionId));
      return { token: fresh.accessToken, expiresAt };
    });

  /**
   * An access token for the connection. `rejected` is one the provider just
   * refused although it hadn't expired by our clock: it isn't handed back.
   */
  return async function accessToken(connectionId: string, rejected?: string) {
    const [connection] = await db
      .select({
        status: connections.status,
        provider: connections.provider,
        accessTokenCiphertext: connections.accessTokenCiphertext,
        accessTokenExpiresAt: connections.accessTokenExpiresAt,
      })
      .from(connections)
      .where(eq(connections.id, connectionId));
    if (!connection) throw new Error(`No connection ${connectionId}`);
    const unavailable = (status: "expired" | "disconnected") => {
      cache.delete(connectionId);
      return new ConnectionUnavailableError(
        connectionId,
        status,
        connection.provider,
      );
    };
    if (connection.status === "expired" || connection.status === "disconnected")
      throw unavailable(connection.status);

    const cached = cache.get(connectionId);
    if (cached && usable(cached, rejected)) return cached.token;
    // One another service stored is good without taking the lock.
    const stored = await storedToken(connectionId, connection);
    const held =
      stored && usable(stored, rejected)
        ? stored
        : await refreshed(connectionId, rejected);
    if (held === "expired") throw unavailable("expired");
    cache.set(connectionId, held);
    return held.token;
  };
}
