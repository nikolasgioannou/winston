import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import { calendarChannels, jobs } from "@winston/db/schema";
import {
  inRollback,
  insertConnection,
  insertUser,
  testDb,
} from "@winston/db/testing";
import { eq } from "drizzle-orm";
import { createApp } from "../app.ts";
import { testDeps } from "../testing.ts";

const db = await testDb();
const sha256 = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

async function channel(tx: DbOrTx) {
  const user = await insertUser(tx);
  const connection = await insertConnection(tx, user.id, {
    domain: "calendar",
  });
  await tx.insert(calendarChannels).values({
    id: "chan-1",
    connectionId: connection.id,
    calendarId: "primary",
    resourceId: "res-1",
    tokenHash: sha256("secret-token"),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return connection;
}

const notify = (tx: DbOrTx, headers: Record<string, string>) =>
  createApp(testDeps(tx).deps).request("/webhooks/calendar", {
    method: "POST",
    headers: {
      "X-Goog-Channel-ID": "chan-1",
      "X-Goog-Channel-Token": "secret-token",
      "X-Goog-Resource-State": "exists",
      ...headers,
    },
  });

const syncs = (tx: DbOrTx) =>
  tx.select().from(jobs).where(eq(jobs.type, "sync_connection"));

describe("calendar push webhook", () => {
  test("a change on a known channel with its token queues one sync; repeats share it", async () => {
    await inRollback(db, async (tx) => {
      const connection = await channel(tx);
      expect((await notify(tx, {})).status).toBe(204);
      expect((await notify(tx, {})).status).toBe(204);
      expect((await syncs(tx)).map((j) => j.payload)).toEqual([
        { connectionId: connection.id },
      ]);
    });
  });

  test("the channel's first message only confirms it; a wrong token is refused; unknown channels are ignored", async () => {
    await inRollback(db, async (tx) => {
      await channel(tx);
      expect(
        (await notify(tx, { "X-Goog-Resource-State": "sync" })).status,
      ).toBe(204);
      expect(
        (await notify(tx, { "X-Goog-Channel-Token": "guess" })).status,
      ).toBe(401);
      expect(
        (await notify(tx, { "X-Goog-Channel-ID": "old-chan" })).status,
      ).toBe(204);
      expect(await syncs(tx)).toHaveLength(0);
    });
  });
});
