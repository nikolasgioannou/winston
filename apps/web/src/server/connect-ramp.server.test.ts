import { describe, expect, test } from "bun:test";
import { tokenContext } from "@winston/db/connections";
import { connections, jobs } from "@winston/db/schema";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import { rampConnectScopes } from "@winston/domain/connections";
import { localTokenVault } from "@winston/shared/token-vault";
import { eq } from "drizzle-orm";
import { completeRampConnect, type ConnectCookies } from "./connect.server";

const db = await testDb();
const vault = localTokenVault("ab".repeat(32));
const ramp = {
  clientId: "ramp_id_local",
  redirectUri: "http://localhost:3002/auth/ramp/connect/callback",
};
const cookies: ConnectCookies = {
  state: "the-state",
  codeVerifier: "the-verifier",
  domain: "ramp",
};
const query = new URLSearchParams({ code: "the-code", state: "the-state" });

/**
 * Ramp's token endpoint and MCP server behind one `fetch`, shaped as the
 * spike saw them (docs/research/ramp-mcp.md, Verified).
 */
function fakeRamp({
  scope = rampConnectScopes.join(" "),
  email = "Ada@Acme.com",
}: { scope?: string; email?: string } = {}) {
  const forms: URLSearchParams[] = [];
  const fetch = ((url: string, init: RequestInit) => {
    if (url.includes("/token/pkce")) {
      forms.push(new URLSearchParams(init.body as string));
      return Promise.resolve(
        Response.json({
          access_token: "access-one",
          refresh_token: "refresh-one",
          expires_in: 3600,
          token_type: "Bearer",
          scope,
        }),
      );
    }
    const body = JSON.parse(init.body as string) as {
      id?: number;
      method: string;
    };
    if (body.method === "initialize")
      return Promise.resolve(
        Response.json(
          { jsonrpc: "2.0", id: body.id, result: {} },
          { headers: { "mcp-session-id": "s1" } },
        ),
      );
    if (body.method === "notifications/initialized")
      return Promise.resolve(new Response(null, { status: 202 }));
    return Promise.resolve(
      Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                users: [{ id: "u1", business_id: "b1", email }],
              }),
            },
          ],
        },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, forms };
}

describe("completeRampConnect", () => {
  test("stores the Ramp account by its email, with only reading on and the token sealed", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const { fetch, forms } = fakeRamp();
      const result = await completeRampConnect(
        { db: tx, ramp, vault, fetch },
        user.id,
        query,
        cookies,
      );
      const [row] = await tx
        .select()
        .from(connections)
        .where(eq(connections.userId, user.id));
      if (!row) throw new Error("expected a connection");
      expect(result).toEqual({ redirectTo: `/accounts?connected=${row.id}` });
      expect(row).toMatchObject({
        domain: "ramp",
        provider: "ramp",
        externalEmail: "ada@acme.com",
        capabilities: {
          read: true,
          edit: false,
          submit: false,
          approve: false,
        },
        status: "ok",
      });
      expect(
        await vault.decrypt(row.tokenCiphertext ?? "", tokenContext(row.id)),
      ).toBe("refresh-one");
      expect(Object.fromEntries(forms[0] ?? [])).toMatchObject({
        grant_type: "authorization_code",
        code: "the-code",
        code_verifier: "the-verifier",
        client_id: "ramp_id_local",
        resource: "https://mcp.ramp.com/mcp",
      });
      // Ramp has no change feed: no watch is asked for.
      const watches = await tx
        .select()
        .from(jobs)
        .where(eq(jobs.type, "watch_connection"));
      expect(watches).toEqual([]);
    });
  });

  test("reading must be granted; otherwise nothing is saved", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const { fetch } = fakeRamp({ scope: "users:read" });
      const result = await completeRampConnect(
        { db: tx, ramp, vault, fetch },
        user.id,
        query,
        cookies,
      );
      expect(result).toEqual({ redirectTo: "/accounts?error=missing_scopes" });
      expect(
        await tx
          .select()
          .from(connections)
          .where(eq(connections.userId, user.id)),
      ).toEqual([]);
    });
  });

  test("a wrong state, a refusal or no Ramp client here saves nothing", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const { fetch } = fakeRamp();
      const deps = { db: tx, ramp, vault, fetch };
      expect(
        await completeRampConnect(deps, user.id, query, {
          ...cookies,
          state: "another-state",
        }),
      ).toEqual({ redirectTo: "/accounts?error=oauth" });
      expect(
        await completeRampConnect(
          deps,
          user.id,
          new URLSearchParams({ error: "access_denied", state: "the-state" }),
          cookies,
        ),
      ).toEqual({ redirectTo: "/accounts?error=oauth" });
      expect(
        await completeRampConnect(
          { ...deps, ramp: undefined },
          user.id,
          query,
          cookies,
        ),
      ).toEqual({ redirectTo: "/accounts?error=unavailable" });
      expect(
        await tx
          .select()
          .from(connections)
          .where(eq(connections.userId, user.id)),
      ).toEqual([]);
    });
  });

  test("connecting the same login again keeps one connection with the new token", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const { fetch } = fakeRamp();
      const deps = { db: tx, ramp, vault, fetch };
      await completeRampConnect(deps, user.id, query, cookies);
      await completeRampConnect(deps, user.id, query, cookies);
      expect(
        await tx
          .select()
          .from(connections)
          .where(eq(connections.userId, user.id)),
      ).toHaveLength(1);
    });
  });
});
