import { tokenContext } from "@winston/db/connections";
import { connections } from "@winston/db/schema";
import type { TokenVault } from "@winston/shared/token-vault";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { JobHandler } from "../worker.ts";

const revokeEndpoint = "https://oauth2.googleapis.com/revoke";

/** Revokes a Google token. Returns normally when it's revoked or was already invalid. */
export type RevokeGoogleToken = (token: string) => Promise<void>;

export function googleTokenRevoker(
  send: typeof fetch = fetch,
): RevokeGoogleToken {
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
 * that's still disconnected, revokes its grant with Google, unless another of
 * the user's live connections uses the same Google account (revoking one
 * grant revokes them all, which would break it), then deletes the token. The
 * row stays locked meanwhile, so a reconnect waits rather than having its new
 * grant revoked.
 */
export function revokeConnectionTokenHandler({
  vault,
  revoke,
}: {
  vault: TokenVault;
  revoke: RevokeGoogleToken;
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

      const [sibling] = await tx
        .select({ id: connections.id })
        .from(connections)
        .where(
          and(
            eq(connections.userId, connection.userId),
            eq(connections.externalEmail, connection.externalEmail),
            ne(connections.id, connection.id),
            ne(connections.status, "disconnected"),
          ),
        );
      if (sibling)
        logger.info(
          { connectionId, siblingId: sibling.id },
          "another connection uses this Google account; deleting the token without revoking",
        );
      else
        await revoke(
          await vault.decrypt(
            connection.tokenCiphertext,
            tokenContext(connectionId),
          ),
        );

      await tx
        .update(connections)
        .set({ tokenCiphertext: null })
        .where(eq(connections.id, connectionId));
      logger.info(
        { connectionId, revoked: !sibling },
        "disconnected connection's token dealt with",
      );
    });
  };
}
