import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import { saveConnection, tokenContext } from "@winston/db/connections";
import { connections, inboundItems, users } from "@winston/db/schema";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import { localTokenVault } from "@winston/shared/token-vault";
import { eq } from "drizzle-orm";
import { ConnectionUnavailableError } from "./access-token.ts";
import { reconnectUrlFor } from "./grants.ts";
import { rotatingAccessTokens, type RefreshTokens } from "./rotating-tokens.ts";

const db = await testDb();
const vault = localTokenVault("34".repeat(32));
const reconnectUrl = reconnectUrlFor("http://localhost:3002");

/**
 * A provider whose refresh tokens rotate: each one works once, and replaying
 * a spent one loses the grant. Slow enough that two callers would overlap.
 */
function rotatingProvider() {
  let generation = 0;
  const live = new Set(["r0"]);
  const used: string[] = [];
  const refresh: RefreshTokens = async (token) => {
    used.push(token);
    await Bun.sleep(20);
    if (!live.delete(token)) return "invalid_grant";
    generation += 1;
    live.add(`r${String(generation)}`);
    return {
      accessToken: `a${String(generation)}`,
      expiresIn: 3600,
      refreshToken: `r${String(generation)}`,
    };
  };
  return { refresh, used };
}

async function connect(tx: DbOrTx, userId: string) {
  const { connectionId } = await saveConnection(tx, vault, {
    userId,
    domain: "mail",
    provider: "gmail",
    externalEmail: "ada@acme.com",
    scopes: [],
    refreshToken: "r0",
  });
  return connectionId;
}

const refreshTokenOf = async (tx: DbOrTx, connectionId: string) => {
  const [row] = await tx
    .select({ sealed: connections.tokenCiphertext })
    .from(connections)
    .where(eq(connections.id, connectionId));
  return row?.sealed && vault.decrypt(row.sealed, tokenContext(connectionId));
};

describe("rotatingAccessTokens", () => {
  test("two services asking at once refresh once and share the access token", async () => {
    // Real concurrent connections, so committed rows, cleaned up after.
    const user = await insertUser(db);
    try {
      const connectionId = await connect(db, user.id);
      const provider = rotatingProvider();
      const gateway = rotatingAccessTokens({
        db,
        vault,
        reconnectUrl,
        ...provider,
      });
      const agents = rotatingAccessTokens({
        db,
        vault,
        reconnectUrl,
        ...provider,
      });

      expect(
        await Promise.all([gateway(connectionId), agents(connectionId)]),
      ).toEqual(["a1", "a1"]);
      expect(provider.used).toEqual(["r0"]);
      expect(await refreshTokenOf(db, connectionId)).toBe("r1");
    } finally {
      await db.delete(users).where(eq(users.id, user.id));
    }
  });

  test("stores the rotated refresh token, and the next refresh uses it", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const connectionId = await connect(tx, user.id);
      const provider = rotatingProvider();
      let clock = 0;
      const options = { db: tx, vault, reconnectUrl, now: () => clock };
      const accessToken = rotatingAccessTokens({ ...options, ...provider });

      expect(await accessToken(connectionId)).toBe("a1");
      // Another service with nothing in memory uses the stored token.
      const other = rotatingAccessTokens({ ...options, ...provider });
      expect(await other(connectionId)).toBe("a1");
      clock = 3_600_000 - 30_000;
      expect(await accessToken(connectionId)).toBe("a2");
      expect(provider.used).toEqual(["r0", "r1"]);
      expect(await refreshTokenOf(tx, connectionId)).toBe("r2");
    });
  });

  test("a grant the provider refuses expires the connection and tells Winston once", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const connectionId = await connect(tx, user.id);
      const refresh: RefreshTokens = () => Promise.resolve("invalid_grant");
      const accessToken = rotatingAccessTokens({
        db: tx,
        vault,
        reconnectUrl,
        refresh,
      });

      for (let i = 0; i < 2; i++) {
        const error = await accessToken(connectionId).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConnectionUnavailableError);
      }
      const [row] = await tx
        .select({ status: connections.status })
        .from(connections)
        .where(eq(connections.id, connectionId));
      expect(row?.status).toBe("expired");
      const expired = (
        await tx
          .select({ type: inboundItems.type })
          .from(inboundItems)
          .where(eq(inboundItems.userId, user.id))
      ).filter((item) => item.type === "system.app.auth_expired");
      expect(expired).toHaveLength(1);
    });
  });
});
