import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import { jobs } from "@winston/db/schema";
import {
  inRollback,
  insertConnection,
  insertUser,
  testDb,
} from "@winston/db/testing";
import { createLogger } from "@winston/shared/logger";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ApiEnv } from "../app.ts";
import { pushToken, testJwks, testPush } from "../testing.ts";
import { gmailWebhookRoutes } from "./gmail-webhook.ts";

const db = await testDb();
const logger = createLogger("api-test", {
  pretty: false,
  destination: { write: () => undefined },
});

function app(tx: DbOrTx, configured = true) {
  return new Hono<ApiEnv>()
    .use(async (c, next) => {
      c.set("logger", logger);
      await next();
    })
    .route(
      "/webhooks/gmail",
      gmailWebhookRoutes({
        db: tx,
        push: configured ? testPush : undefined,
        keys: testJwks,
      }),
    );
}

const push = async (
  tx: DbOrTx,
  data: unknown,
  token?: string,
  configured = true,
) =>
  app(tx, configured).request("/webhooks/gmail", {
    method: "POST",
    headers: { Authorization: `Bearer ${token ?? (await pushToken())}` },
    body: JSON.stringify({
      message: {
        data: Buffer.from(
          typeof data === "string" ? data : JSON.stringify(data),
        ).toString("base64"),
        messageId: "m1",
      },
      subscription: "projects/winston-510100/subscriptions/gmail-push-push",
    }),
  });

const syncs = (tx: DbOrTx) =>
  tx.select().from(jobs).where(eq(jobs.type, "sync_connection"));

describe("Gmail push webhook", () => {
  test("a verified push queues one sync per matching mail connection, and a burst is still one", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const mail = await insertConnection(tx, user.id, {
        externalEmail: "me@example.com",
      });
      await insertConnection(tx, user.id, {
        domain: "calendar",
        externalEmail: "me@example.com",
      });
      for (const historyId of ["100", "101", "102"]) {
        const response = await push(tx, {
          emailAddress: "Me@Example.com",
          historyId,
        });
        expect(response.status).toBe(204);
      }
      const queued = await syncs(tx);
      expect(queued.map((job) => job.payload)).toEqual([
        { connectionId: mail.id },
      ]);
    });
  });

  test("unknown addresses and malformed data are acknowledged and ignored", async () => {
    await inRollback(db, async (tx) => {
      expect(
        (await push(tx, { emailAddress: "nobody@example.com", historyId: 1 }))
          .status,
      ).toBe(204);
      expect((await push(tx, "not json")).status).toBe(204);
      expect(await syncs(tx)).toHaveLength(0);
    });
  });

  test("a bad token is refused; without configuration nothing is accepted", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await insertConnection(tx, user.id, { externalEmail: "me@example.com" });
      const data = { emailAddress: "me@example.com", historyId: "1" };
      const forged = await pushToken({ email: "attacker@example.com" });
      expect((await push(tx, data, forged)).status).toBe(401);
      expect((await push(tx, data, undefined, false)).status).toBe(503);
      expect(await syncs(tx)).toHaveLength(0);
    });
  });
});
