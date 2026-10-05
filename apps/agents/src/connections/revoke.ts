import { tokenContext } from "@winston/db/connections";
import { connections } from "@winston/db/schema";
import type { TokenVault } from "@winston/shared/token-vault";
import {
  providersIssuedBy,
  providerTraits,
  type ConnectionProvider,
  type TokenIssuer,
} from "@winston/domain/connections";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import type { JobHandler } from "../worker.ts";

const revokeEndpoint = "https://oauth2.googleapis.com/revoke";

/** Revokes a token. Returns normally when it's revoked or was already invalid. */
export type RevokeToken = (token: string) => Promise<void>;

/** A revoker for each issuer's tokens. */
export type Revokers = Record<TokenIssuer, RevokeToken>;

export function googleTokenRevoker(send: typeof fetch = fetch): RevokeToken {
  return async (token) => {
    const response = await send(revokeEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    if (response.ok) return;
    // A token that's expired or already revoked has nothing left to revoke.
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    if (response.status === 400 && body.error === "invalid_token") return;
    throw new Error(
      `Google's revoke endpoint answered ${String(response.status)}: ${body.error ?? "no error code"}`,
    );
  };
}

/**
 * The `revoke_connection_token` job (docs/design.md §12a): for a connection
 * that's still disconnected, revokes its grant with its issuer, unless another
 * of the user's live connections from that issuer uses the same account
 * (revoking one Google grant revokes them all, which would break it), then
 * deletes the token. The row stays locked meanwhile, so a reconnect waits
 * rather than having its new grant revoked.
 */
export function revokeConnectionTokenHandler({
  vault,
  revoke,
  stopWatch,
}: {
  vault: TokenVault;
  revoke: Revokers;
  /** Ends an account's watches with its refresh token, before the token goes (§3). */
  stopWatch?: (
    connection: { id: string; provider: ConnectionProvider },
    refreshToken: string,
  ) => Promise<void>;
}): JobHandler {
  return async ({ job, db, logger }) => {
    const { connectionId } = z
      .object({ connectionId: z.string() })
      .parse(job.payload);
    await db.transaction(async (tx) => {
      const [connection] = await tx
        .select()
        .from(connections)
        .where(eq(connections.id, connectionId))
        .for("update");
      if (connection?.status !== "disconnected" || !connection.tokenCiphertext)
        return;
      const issuer = providerTraits[connection.provider].issuer;
      if (!issuer) return;

      const [sibling] = await tx
        .select({ id: connections.id })
        .from(connections)
        .where(
          and(
            eq(connections.userId, connection.userId),
            eq(connections.externalEmail, connection.externalEmail),
            inArray(connections.provider, providersIssuedBy(issuer)),
            ne(connections.id, connection.id),
            ne(connections.status, "disconnected"),
          ),
        );
      const refreshToken = await vault.decrypt(
        connection.tokenCiphertext,
        tokenContext(connectionId),
      );
      // Best effort: notifications for a disconnected account are ignored anyway.
      if (connection.watchExpiresAt && stopWatch)
        await stopWatch(connection, refreshToken).catch((error: unknown) => {
          logger.warn(
            { err: error, connectionId },
            "stopping the watch failed",
          );
        });
      if (sibling)
        logger.info(
          { connectionId, siblingId: sibling.id },
          "another connection uses this account's grant; deleting the token without revoking",
        );
      else await revoke[issuer](refreshToken);

      await tx
        .update(connections)
        .set({
          tokenCiphertext: null,
          accessTokenCiphertext: null,
          accessTokenExpiresAt: null,
          watchExpiresAt: null,
        })
        .where(eq(connections.id, connectionId));
      logger.info(
        { connectionId, revoked: !sibling },
        "disconnected connection's token dealt with",
      );
    });
  };
}
