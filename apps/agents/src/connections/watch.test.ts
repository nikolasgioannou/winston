import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import type { Job } from "@winston/db/queue";
import { connections, jobs } from "@winston/db/schema";
import {
  inRollback,
  insertConnection,
  insertUser,
  testDb,
} from "@winston/db/testing";
import { createLogger } from "@winston/shared/logger";
import { eq } from "drizzle-orm";
import { renewWatches, watchConnectionHandler } from "./watch.ts";

const db = await testDb();
const logger = createLogger("agents-test", {
  pretty: false,
  destination: { write: () => undefined },
});
const topic = "projects/winston-510100/topics/gmail-push";
const day = 86_400_000;

/** A fake Gmail: records watch requests and answers with `status`. */
function gmail(status = 200) {
  const requests: { url: string; body: unknown }[] = [];
  const fetch = ((url: string, init?: RequestInit) => {
    requests.push({ url, body: JSON.parse(init?.body as string) as unknown });
    return Promise.resolve(
      status === 200
        ? Response.json({
            historyId: "4242",
            expiration: String(Date.UTC(2026, 9, 8)),
          })
        : Response.json({ error: { message: "Topic not found" } }, { status }),
    );
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

const watchJob = (
  tx: DbOrTx,
  connectionId: string,
  fetch: typeof globalThis.fetch,
  gmailTopic: string | null = topic,
) =>
  watchConnectionHandler({
    accessToken: () => Promise.resolve("access"),
    gmailTopic: gmailTopic ?? undefined,
    fetch,
  })({
    job: { payload: { connectionId } } as unknown as Job,
    db: tx as never,
    logger,
    extendLease: () => Promise.resolve(true),
  });

const row = async (tx: DbOrTx, id: string) =>
  (await tx.select().from(connections).where(eq(connections.id, id)))[0];

describe("mail watches", () => {
  test("a watch covers the inbox and sent mail, and keeps when it ends and where sync starts", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const mail = await insertConnection(tx, user.id);
      const fake = gmail();
      await watchJob(tx, mail.id, fake.fetch);
      expect(fake.requests[0]).toEqual({
        url: "https://gmail.googleapis.com/gmail/v1/users/me/watch",
        body: {
          topicName: topic,
          labelIds: ["INBOX", "SENT"],
          labelFilterBehavior: "INCLUDE",
        },
      });
      expect(await row(tx, mail.id)).toMatchObject({
        watchExpiresAt: new Date(Date.UTC(2026, 9, 8)),
        syncState: { historyId: "4242" },
      });
      // Renewing keeps sync's own place.
      await tx
        .update(connections)
        .set({ syncState: { historyId: "5000" } })
        .where(eq(connections.id, mail.id));
      await watchJob(tx, mail.id, gmail().fetch);
      expect((await row(tx, mail.id))?.syncState).toEqual({
        historyId: "5000",
      });
    });
  });

  test("no topic means no watch; a refused or missing topic is logged, not retried", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const mail = await insertConnection(tx, user.id);
      const none = gmail();
      await watchJob(tx, mail.id, none.fetch, null);
      expect(none.requests).toHaveLength(0);
      await watchJob(tx, mail.id, gmail(404).fetch);
      await watchJob(tx, mail.id, gmail(403).fetch);
      expect((await row(tx, mail.id))?.watchExpiresAt).toBeNull();
    });
  });

  test("renewal picks usable mail connections whose watch is missing or ends within two days", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const now = new Date("2026-10-01T12:00:00Z");
      const missing = await insertConnection(tx, user.id);
      const soon = await insertConnection(tx, user.id, {
        watchExpiresAt: new Date(now.getTime() + day),
      });
      await insertConnection(tx, user.id, {
        watchExpiresAt: new Date(now.getTime() + 5 * day),
      });
      await insertConnection(tx, user.id, { status: "expired" });
      await insertConnection(tx, user.id, { domain: "calendar" });
      expect(await renewWatches(tx, now)).toBe(2);
      const queued = await tx
        .select({ payload: jobs.payload })
        .from(jobs)
        .where(eq(jobs.type, "watch_connection"));
      expect(
        queued
          .map((j) => (j.payload as { connectionId: string }).connectionId)
          .sort(),
      ).toEqual([missing.id, soon.id].sort());
    });
  });
});
