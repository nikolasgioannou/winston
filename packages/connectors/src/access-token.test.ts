import { describe, expect, test } from "bun:test";
import { saveConnection } from "@winston/db/connections";
import { connections, inboundItems } from "@winston/db/schema";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import { localTokenVault } from "@winston/shared/token-vault";
import { eq } from "drizzle-orm";
import {
  ConnectionUnavailableError,
  googleAccessTokens,
} from "./access-token.ts";
import { reconnectUrlFor } from "./grants.ts";

const db = await testDb();
const vault = localTokenVault("12".repeat(32));
const client = { clientId: "client", clientSecret: "secret" };
const reconnectUrl = reconnectUrlFor("http://localhost:3002");

/** A token endpoint answering each request with the next response. */
function fakeGoogle(...responses: { status: number; body: unknown }[]) {
  const sent: URLSearchParams[] = [];
  const fetch = ((_url: string, init?: RequestInit) => {
    sent.push(new URLSearchParams(init?.body as URLSearchParams));
    const next = responses.shift() ?? { status: 500, body: {} };
    return Promise.resolve(Response.json(next.body, { status: next.status }));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

describe("googleAccessTokens", () => {
  test("refreshes with the decrypted token, caches until shortly before expiry, then refreshes again", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const { connectionId } = await saveConnection(tx, vault, {
        userId: user.id,
        domain: "mail",
        provider: "gmail",
        externalEmail: "ada@acme.com",
        scopes: ["gmail.modify"],
        refreshToken: "1//refresh",
      });
      const google = fakeGoogle(
        { status: 200, body: { access_token: "a1", expires_in: 3600 } },
        { status: 200, body: { access_token: "a2", expires_in: 3600 } },
      );
      let clock = 0;
      const accessToken = googleAccessTokens({
        db: tx,
        vault,
        client,
        reconnectUrl,
        fetch: google.fetch,
        now: () => clock,
      });

      expect(await accessToken(connectionId)).toBe("a1");
      clock = 3_000_000;
      expect(await accessToken(connectionId)).toBe("a1");
      clock = 3_600_000 - 30_000;
      expect(await accessToken(connectionId)).toBe("a2");
      expect(google.sent).toHaveLength(2);
      expect(Object.fromEntries(google.sent[0] ?? [])).toEqual({
        grant_type: "refresh_token",
        refresh_token: "1//refresh",
        client_id: "client",
        client_secret: "secret",
      });
    });
  });

  test("invalid_grant marks the connection expired, tells Winston, and fails every call after", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const { connectionId } = await saveConnection(tx, vault, {
        userId: user.id,
        domain: "mail",
        provider: "gmail",
        externalEmail: "ada@acme.com",
        scopes: ["gmail.modify"],
        refreshToken: "1//refresh",
      });
      const google = fakeGoogle({
        status: 400,
        body: { error: "invalid_grant" },
      });
      const accessToken = googleAccessTokens({
        db: tx,
        vault,
        client,
        reconnectUrl,
        fetch: google.fetch,
      });

      for (let i = 0; i < 2; i++) {
        const error = await accessToken(connectionId).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConnectionUnavailableError);
      }
      expect(google.sent).toHaveLength(1);
      const [row] = await tx
        .select()
        .from(connections)
        .where(eq(connections.id, connectionId));
      expect(row?.status).toBe("expired");
      const types = (
        await tx
          .select({ type: inboundItems.type })
          .from(inboundItems)
          .where(eq(inboundItems.userId, user.id))
      ).map((item) => item.type);
      expect(types).toContain("system.app.auth_expired");
    });
  });

  test("other failures are errors to retry, and leave the connection as it was", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const { connectionId } = await saveConnection(tx, vault, {
        userId: user.id,
        domain: "mail",
        provider: "gmail",
        externalEmail: "ada@acme.com",
        scopes: ["gmail.modify"],
        refreshToken: "1//refresh",
      });
      const accessToken = googleAccessTokens({
        db: tx,
        vault,
        client,
        reconnectUrl,
        fetch: fakeGoogle({ status: 503, body: {} }).fetch,
      });
      const error = await accessToken(connectionId).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ConnectionUnavailableError);
      const [row] = await tx
        .select()
        .from(connections)
        .where(eq(connections.id, connectionId));
      expect(row?.status).toBe("ok");
    });
  });
});
