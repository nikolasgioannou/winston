import type { DbOrTx } from "@winston/db/client";
import { tokenContext } from "@winston/db/connections";
import { connections } from "@winston/db/schema";
import type { TokenVault } from "@winston/shared/token-vault";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { markExpired, type ReconnectUrl } from "./grants.ts";

const tokenEndpoint = "https://oauth2.googleapis.com/token";
/** An access token this close to expiring is refreshed rather than used. */
const refreshBeforeMs = 60_000;

/** The connection can't be used until the user acts: it's expired or disconnected. */
export class ConnectionUnavailableError extends Error {
  override name = "ConnectionUnavailableError";
  constructor(
    readonly connectionId: string,
    readonly status: "expired" | "disconnected",
  ) {
    super(`Connection ${connectionId} is ${status}.`);
  }
}

const refreshResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
});

/**
 * Access tokens for connected Google accounts, for every connector call
 * (docs/design.md §12a): the refresh token is decrypted, traded for an access
 * token, and that's cached until shortly before it expires. When Google says
 * `invalid_grant` (the 7-day grant ran out or the user revoked it), the
 * connection is marked `expired` and the call fails with
 * `ConnectionUnavailableError`.
 */
export function googleAccessTokens({
  db,
  vault,
  client,
  reconnectUrl,
  fetch: send = fetch,
  now = () => Date.now(),
}: {
  db: DbOrTx;
  vault: TokenVault;
  client: { clientId: string; clientSecret: string };
  reconnectUrl: ReconnectUrl;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const cache = new Map<string, { token: string; expiresAt: number }>();

  return async function accessToken(connectionId: string) {
    const [connection] = await db
      .select({
        status: connections.status,
        tokenCiphertext: connections.tokenCiphertext,
      })
      .from(connections)
      .where(eq(connections.id, connectionId));
    if (!connection) throw new Error(`No connection ${connectionId}`);
    if (
      connection.status === "expired" ||
      connection.status === "disconnected"
    ) {
      cache.delete(connectionId);
      throw new ConnectionUnavailableError(connectionId, connection.status);
    }

    const cached = cache.get(connectionId);
    if (cached && cached.expiresAt - refreshBeforeMs > now())
      return cached.token;

    if (!connection.tokenCiphertext)
      throw new ConnectionUnavailableError(connectionId, "disconnected");
    const refreshToken = await vault.decrypt(
      connection.tokenCiphertext,
      tokenContext(connectionId),
    );
    const response = await send(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (response.status === 400 && body.error === "invalid_grant") {
        cache.delete(connectionId);
        await markExpired(db, connectionId, reconnectUrl);
        throw new ConnectionUnavailableError(connectionId, "expired");
      }
      throw new Error(
        `Refreshing a Google token failed with ${String(response.status)}: ${body.error ?? "no error code"}`,
      );
    }
    const fresh = refreshResponseSchema.parse(await response.json());
    cache.set(connectionId, {
      token: fresh.access_token,
      expiresAt: now() + fresh.expires_in * 1000,
    });
    return fresh.access_token;
  };
}
