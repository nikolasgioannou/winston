import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import { tokenContext } from "@winston/db/connections";
import type { Job } from "@winston/db/queue";
import { connections } from "@winston/db/schema";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import { createLogger } from "@winston/shared/logger";
import { localTokenVault } from "@winston/shared/token-vault";
import { eq } from "drizzle-orm";
import { googleTokenRevoker, revokeConnectionTokenHandler } from "./revoke.ts";

const db = await testDb();
const vault = localTokenVault("cd".repeat(32));
const logger = createLogger("agents-test", {
  pretty: false,
  destination: { write: () => undefined },
});

async function connectionFor(
  tx: DbOrTx,
  userId: string,
  overrides: Partial<typeof connections.$inferInsert> = {},
) {
  const id = overrides.id ?? `acct_${crypto.randomUUID()}`;
  await tx.insert(connections).values({
    id,
    userId,
    domain: "mail",
    provider: "gmail",
    externalEmail: "ada@acme.com",
    tokenCiphertext: await vault.encrypt(`refresh-${id}`, tokenContext(id)),
    grantedAt: new Date(),
    status: "disconnected",
    ...overrides,
  });
  return id;
}

function run(
  tx: DbOrTx,
  connectionId: string,
  revoked: string[],
  stopped: string[] = [],
) {
  return revokeConnectionTokenHandler({
    vault,
    revoke: (token) => {
      revoked.push(token);
      return Promise.resolve();
    },
    stopWatch: (token) => {
      stopped.push(token);
      return Promise.resolve();
    },
  })({
    job: { id: "job_1", payload: { connectionId } } as unknown as Job,
    db: tx as never,
    logger,
    extendLease: () => Promise.resolve(true),
  });
}

const tokenOf = async (tx: DbOrTx, id: string) =>
  (await tx.select().from(connections).where(eq(connections.id, id)))[0]
    ?.tokenCiphertext;

describe("revokeConnectionTokenHandler", () => {
  test("revokes a disconnected connection's grant with Google and deletes the token", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const id = await connectionFor(tx, user.id);
      const revoked: string[] = [];
      await run(tx, id, revoked);
      expect(revoked).toEqual([`refresh-${id}`]);
      expect(await tokenOf(tx, id)).toBeNull();
    });
  });

  test("stops a watched mail account's watch first, and forgets the watch", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const watched = await connectionFor(tx, user.id, {
        watchExpiresAt: new Date(Date.now() + 86_400_000),
      });
      const unwatched = await connectionFor(tx, user.id, {
        externalEmail: "other@acme.com",
      });
      const stopped: string[] = [];
      await run(tx, watched, [], stopped);
      await run(tx, unwatched, [], stopped);
      expect(stopped).toEqual([`refresh-${watched}`]);
      const [row] = await tx
        .select()
        .from(connections)
        .where(eq(connections.id, watched));
      expect(row?.watchExpiresAt).toBeNull();
    });
  });

  test("doesn't revoke while another live connection uses the same Google account, but still deletes the token", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const mail = await connectionFor(tx, user.id);
      const calendar = await connectionFor(tx, user.id, {
        domain: "calendar",
        provider: "google_calendar",
        status: "ok",
      });
      const revoked: string[] = [];
      await run(tx, mail, revoked);
      expect(revoked).toEqual([]);
      expect(await tokenOf(tx, mail)).toBeNull();
      expect(await tokenOf(tx, calendar)).not.toBeNull();
    });
  });

  test("leaves a connection that was reconnected meanwhile alone", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const id = await connectionFor(tx, user.id, { status: "ok" });
      const revoked: string[] = [];
      await run(tx, id, revoked);
      expect(revoked).toEqual([]);
      expect(await tokenOf(tx, id)).not.toBeNull();
    });
  });
});

describe("googleTokenRevoker", () => {
  const answering = (status: number, body: unknown) => {
    const sent: string[] = [];
    const fetch = ((_url: string, init?: RequestInit) => {
      sent.push(new URLSearchParams(init?.body as URLSearchParams).toString());
      return Promise.resolve(Response.json(body, { status }));
    }) as unknown as typeof globalThis.fetch;
    return { fetch, sent };
  };

  test("posts the token, and treats an already invalid one as revoked", async () => {
    const ok = answering(200, {});
    await googleTokenRevoker(ok.fetch)("tok");
    expect(ok.sent).toEqual(["token=tok"]);
    await googleTokenRevoker(answering(400, { error: "invalid_token" }).fetch)(
      "tok",
    );
  });

  test("fails on anything else, so the job retries", async () => {
    const failed = await googleTokenRevoker(answering(503, {}).fetch)(
      "tok",
    ).then(
      () => false,
      () => true,
    );
    expect(failed).toBe(true);
  });
});
