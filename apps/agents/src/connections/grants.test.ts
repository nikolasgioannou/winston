import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import { saveConnection } from "@winston/db/connections";
import { connections, inboundItems } from "@winston/db/schema";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import { createLogger } from "@winston/shared/logger";
import { localTokenVault } from "@winston/shared/token-vault";
import { eq } from "drizzle-orm";
import {
  grantLifetimeMs,
  reconnectUrlFor,
  sweepConnectionGrants,
  warnBeforeMs,
} from "./grants.ts";

const db = await testDb();
const logger = createLogger("agents-test", {
  pretty: false,
  destination: { write: () => undefined },
});
const vault = localTokenVault("ef".repeat(32));
const reconnectUrl = reconnectUrlFor("https://runwinston.com");
const hour = 60 * 60_000;

async function connected(tx: DbOrTx) {
  const user = await insertUser(tx);
  const { connectionId } = await saveConnection(tx, vault, {
    userId: user.id,
    domain: "mail",
    provider: "gmail",
    externalEmail: "ada@acme.com",
    scopes: ["gmail.modify"],
    refreshToken: "refresh",
  });
  const [row] = await tx
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId));
  if (!row) throw new Error("expected the connection");
  return { userId: user.id, id: connectionId, grantedAt: row.grantedAt };
}

const statusOf = async (tx: DbOrTx, id: string) =>
  (await tx.select().from(connections).where(eq(connections.id, id)))[0]
    ?.status;
const grantEvents = async (tx: DbOrTx, userId: string) =>
  (
    await tx
      .select({ type: inboundItems.type, payload: inboundItems.payload })
      .from(inboundItems)
      .where(eq(inboundItems.userId, userId))
  ).filter((item) => item.type.startsWith("system.app.auth_"));

describe("sweepConnectionGrants", () => {
  test("warns from a day before the 7 days are up, once per grant, then expires", async () => {
    await inRollback(db, async (tx) => {
      const { userId, id, grantedAt } = await connected(tx);
      const at = (ms: number) => new Date(grantedAt.getTime() + ms);
      const sweep = (ms: number) =>
        sweepConnectionGrants(tx, logger, { reconnectUrl, now: at(ms) });

      await sweep(grantLifetimeMs - warnBeforeMs - hour);
      expect(await statusOf(tx, id)).toBe("ok");

      await sweep(grantLifetimeMs - warnBeforeMs + hour);
      await sweep(grantLifetimeMs - warnBeforeMs + 2 * hour);
      expect(await statusOf(tx, id)).toBe("expiring");
      const [warning] = await grantEvents(tx, userId);
      expect(await grantEvents(tx, userId)).toHaveLength(1);
      expect(warning).toEqual({
        type: "system.app.auth_expiring",
        payload: {
          connectionId: id,
          domain: "mail",
          provider: "gmail",
          alias: "work",
          externalEmail: "ada@acme.com",
          expiresAt: at(grantLifetimeMs).toISOString(),
          reconnectUrl: `https://runwinston.com/auth/google/connect?reconnect=${id}`,
        },
      });

      await sweep(grantLifetimeMs + hour);
      await sweep(grantLifetimeMs + 2 * hour);
      expect(await statusOf(tx, id)).toBe("expired");
      expect((await grantEvents(tx, userId)).map((e) => e.type)).toEqual([
        "system.app.auth_expiring",
        "system.app.auth_expired",
      ]);
    });
  });

  test("reconnecting resets the grant, so the next one warns again", async () => {
    await inRollback(db, async (tx) => {
      const { userId, id, grantedAt } = await connected(tx);
      await sweepConnectionGrants(tx, logger, {
        reconnectUrl,
        now: new Date(grantedAt.getTime() + grantLifetimeMs - hour),
      });
      expect(await statusOf(tx, id)).toBe("expiring");

      const regranted = new Date(
        grantedAt.getTime() + grantLifetimeMs - hour / 2,
      );
      await saveConnection(tx, vault, {
        userId,
        domain: "mail",
        provider: "gmail",
        externalEmail: "ada@acme.com",
        scopes: ["gmail.modify"],
        refreshToken: "refresh-2",
      });
      await tx
        .update(connections)
        .set({ grantedAt: regranted })
        .where(eq(connections.id, id));
      expect(await statusOf(tx, id)).toBe("ok");

      await sweepConnectionGrants(tx, logger, {
        reconnectUrl,
        now: new Date(regranted.getTime() + grantLifetimeMs - hour),
      });
      expect(await statusOf(tx, id)).toBe("expiring");
      expect((await grantEvents(tx, userId)).map((e) => e.type)).toEqual([
        "system.app.auth_expiring",
        "system.app.auth_expiring",
      ]);
    });
  });

  test("leaves disconnected connections alone", async () => {
    await inRollback(db, async (tx) => {
      const { userId, id, grantedAt } = await connected(tx);
      await tx
        .update(connections)
        .set({ status: "disconnected" })
        .where(eq(connections.id, id));
      await sweepConnectionGrants(tx, logger, {
        reconnectUrl,
        now: new Date(grantedAt.getTime() + 2 * grantLifetimeMs),
      });
      expect(await statusOf(tx, id)).toBe("disconnected");
      expect(await grantEvents(tx, userId)).toEqual([]);
    });
  });
});
