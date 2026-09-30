import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import { tokenContext, toConnectionDto } from "@winston/db/connections";
import { connections, inboundItems, jobs } from "@winston/db/schema";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import { localTokenVault } from "@winston/shared/token-vault";
import { eq } from "drizzle-orm";
import { completeGoogleConnect, type ConnectCookies } from "./connect.server";
import { fakeGoogle, goodClaims, idToken } from "./google.server.test";

const db = await testDb();
const vault = localTokenVault("ab".repeat(32));
const google = {
  clientId: goodClaims.aud,
  clientSecret: "secret",
  redirectUri: "http://localhost:3002/auth/google/connect/callback",
};
const cookies = (domain = "mail"): ConnectCookies => ({
  state: "the-state",
  codeVerifier: "the-verifier",
  domain,
});
const query = new URLSearchParams({ code: "the-code", state: "the-state" });
const scope = (...scopes: string[]) =>
  ["openid", "https://www.googleapis.com/auth/userinfo.email"]
    .concat(scopes.map((s) => `https://www.googleapis.com/auth/${s}`))
    .join(" ");

/** Google answering with a grant for Ada's work account. */
const grant = (overrides: Record<string, unknown> = {}) =>
  fakeGoogle({
    id_token: idToken({ ...goodClaims, email: "Ada@Acme.com" }),
    refresh_token: "1//refresh-one",
    scope: scope("gmail.modify"),
    ...overrides,
  });

const connectionsOf = (tx: DbOrTx, userId: string) =>
  tx.select().from(connections).where(eq(connections.userId, userId));

describe("completeGoogleConnect", () => {
  test("stores the account with its token encrypted, the granted scopes and the defaults, and tells Winston", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const { fetch } = grant();
      const result = await completeGoogleConnect(
        { db: tx, google, vault, fetch },
        user.id,
        query,
        cookies(),
      );
      const [row] = await connectionsOf(tx, user.id);
      if (!row) throw new Error("expected a connection");
      expect(result).toEqual({ redirectTo: `/accounts?connected=${row.id}` });
      expect(row).toMatchObject({
        domain: "mail",
        provider: "gmail",
        externalEmail: "ada@acme.com",
        alias: "work",
        scopes: ["gmail.modify"],
        capabilities: {
          read: true,
          draft: true,
          send: false,
          modify_labels: false,
        },
        status: "ok",
      });
      expect(row.tokenCiphertext).not.toContain("refresh-one");
      expect(
        await vault.decrypt(row.tokenCiphertext, tokenContext(row.id)),
      ).toBe("1//refresh-one");
      expect(JSON.stringify(toConnectionDto(row))).not.toContain(
        row.tokenCiphertext,
      );

      const [item] = await tx
        .select()
        .from(inboundItems)
        .where(eq(inboundItems.userId, user.id));
      expect(item).toMatchObject({
        type: "system.app.connected",
        payload: {
          connectionId: row.id,
          domain: "mail",
          provider: "gmail",
          alias: "work",
          externalEmail: "ada@acme.com",
        },
      });
      expect(
        await tx
          .select({ type: jobs.type })
          .from(jobs)
          .where(eq(jobs.userId, user.id)),
      ).toEqual([{ type: "front_turn" }]);
    });
  });

  test("reconnecting the same account refreshes it instead of adding another, without telling Winston again", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await completeGoogleConnect(
        { db: tx, google, vault, fetch: grant().fetch },
        user.id,
        query,
        cookies(),
      );
      const [first] = await connectionsOf(tx, user.id);
      await tx
        .update(connections)
        .set({ status: "expired", alias: "day job" })
        .where(eq(connections.userId, user.id));

      await completeGoogleConnect(
        {
          db: tx,
          google,
          vault,
          fetch: grant({ refresh_token: "1//refresh-two" }).fetch,
        },
        user.id,
        query,
        cookies(),
      );
      const rows = await connectionsOf(tx, user.id);
      expect(rows).toHaveLength(1);
      const [again] = rows;
      if (!first || !again) throw new Error("expected the connection");
      expect(again).toMatchObject({
        id: first.id,
        status: "ok",
        alias: "day job",
      });
      expect(again.grantedAt.getTime()).toBeGreaterThanOrEqual(
        first.grantedAt.getTime(),
      );
      expect(
        await vault.decrypt(again.tokenCiphertext, tokenContext(again.id)),
      ).toBe("1//refresh-two");
      expect(
        await tx
          .select()
          .from(inboundItems)
          .where(eq(inboundItems.userId, user.id)),
      ).toHaveLength(1);
    });
  });

  test("a second account in the same domain gets its own alias; the calendar keeps what was granted", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await completeGoogleConnect(
        { db: tx, google, vault, fetch: grant().fetch },
        user.id,
        query,
        cookies(),
      );
      await completeGoogleConnect(
        {
          db: tx,
          google,
          vault,
          fetch: grant({
            id_token: idToken({ ...goodClaims, email: "ada@bigco.com" }),
          }).fetch,
        },
        user.id,
        query,
        cookies(),
      );
      await completeGoogleConnect(
        {
          db: tx,
          google,
          vault,
          fetch: grant({
            scope: scope("calendar.events", "calendar.calendarlist.readonly"),
          }).fetch,
        },
        user.id,
        query,
        cookies("calendar"),
      );
      const rows = await connectionsOf(tx, user.id);
      expect(
        rows.map((r) => [r.domain, r.externalEmail, r.alias, r.scopes]),
      ).toEqual([
        ["mail", "ada@acme.com", "work", ["gmail.modify"]],
        ["mail", "ada@bigco.com", "bigco", ["gmail.modify"]],
        [
          "calendar",
          "ada@acme.com",
          "work",
          ["calendar.events", "calendar.calendarlist.readonly"],
        ],
      ]);
    });
  });

  test("an unticked essential scope, a bad state, a cancelled consent or no refresh token saves nothing", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const run = (fetch: typeof globalThis.fetch, q = query, c = cookies()) =>
        completeGoogleConnect({ db: tx, google, vault, fetch }, user.id, q, c);

      expect(await run(grant({ scope: scope() }).fetch)).toEqual({
        redirectTo: "/accounts?error=missing_scopes",
      });
      const oauth = { redirectTo: "/accounts?error=oauth" } as const;
      expect(
        await run(
          grant().fetch,
          new URLSearchParams({ code: "c", state: "other" }),
        ),
      ).toEqual(oauth);
      expect(
        await run(
          grant().fetch,
          new URLSearchParams({ error: "access_denied" }),
        ),
      ).toEqual(oauth);
      expect(await run(grant().fetch, query, cookies("photos"))).toEqual(oauth);
      expect(await run(grant({ refresh_token: undefined }).fetch)).toEqual(
        oauth,
      );
      expect(await connectionsOf(tx, user.id)).toEqual([]);
    });
  });
});
